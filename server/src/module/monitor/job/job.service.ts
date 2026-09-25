import cluster from 'node:cluster';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Job } from './entities/job.entity';
import { CreateJobDto, UpdateJobDto, ListJobDto } from './dto/create-job.dto';
import { ResultData } from '../../../common/utils/result';
import { TaskService } from './task.service';
import { ExportTable } from '../../../common/utils/export';
import type { Response } from 'express-serve-static-core';
import { RedisService } from '../../../redis/redis.service';
import { CacheEnum } from '../../../common/enum';
import { formatDateTime } from '../../../common/utils/index';

/** 定时任务锁默认 TTL：防止 worker 崩溃后锁无法释放 */
const CRON_LOCK_TTL_MS = Number(process.env.CRON_LOCK_TTL_MS) || 60 * 60 * 1000;

interface CronJobMeta {
  expression: string;
  invokeTarget: string;
  concurrent: string;
  jobGroup: string;
}

@Injectable()
export class JobService {
  private readonly logger = new Logger(JobService.name);
  private readonly cronJobMeta = new Map<string, CronJobMeta>();

  constructor(
    private schedulerRegistry: SchedulerRegistry,
    @InjectRepository(Job)
    private jobRepository: Repository<Job>,
    private taskService: TaskService,
    private readonly redisService: RedisService,
  ) {
    // 构造期异步加载，失败时记录日志避免形成未处理的 Promise rejection
    this.initializeJobs().catch((error) => {
      this.logger.error(`初始化定时任务失败: ${(error as any)?.message}`);
    });
  }

  /**
   * 格式化定时任务数据
   * @param item - 原始任务实体
   * @returns 格式化后的任务对象
   */
  private formatJob(item: Job) {
    const jobId = Number(item.jobId);
    return {
      job_id: jobId,
      id: jobId,
      job_name: item.job_name,
      job_group: item.job_group,
      invoke_target: item.invoke_target,
      cron_expression: item.cron_expression,
      misfire_policy: item.misfire_policy,
      concurrent: item.concurrent,
      status: item.status,
      remark: item.remark,
      create_by: item.create_by,
      update_by: item.update_by,
      create_time: formatDateTime(item.create_time),
      update_time: formatDateTime(item.update_time),
    };
  }

  private isJobActive(status: string) {
    return `${status}` === '0';
  }

  /**
   * 初始化所有启用的定时任务（启动时加载）
   */
  private async initializeJobs() {
    const jobs = await this.jobRepository.find({ where: { del_flag: '0', status: '0' } });
    jobs.forEach((job) => {
      if (job.cron_expression) {
        this.addCronJob(job.job_name, job.cron_expression, job.invoke_target, job.concurrent, job.job_group);
      }
    });
  }

  /**
   * 查询定时任务列表（分页）
   * @param query - 查询条件（任务名称、分组、状态、时间范围）
   * @returns 分页结果
   */
  async list(query: ListJobDto) {
    const entity = this.jobRepository.createQueryBuilder('entity');
    entity.where("entity.del_flag = '0'");

    if (query.job_name) {
      entity.andWhere('entity.job_name LIKE :job_name', { job_name: `%${query.job_name}%` });
    }
    if (query.job_group) {
      entity.andWhere('entity.job_group = :job_group', { job_group: query.job_group });
    }
    if (query.status !== undefined && query.status !== null && `${query.status}` !== '') {
      entity.andWhere('entity.status = :status', { status: `${query.status}` });
    }
    if (query.params?.beginTime && query.params?.endTime) {
      entity.andWhere('entity.create_time BETWEEN :start AND :end', {
        start: query.params.beginTime,
        end: query.params.endTime,
      });
    }

    const pageNum = Number(query.pageNum || query.page || 1);
    const pageSize = Number(query.pageSize || query.limit || 10);
    entity.skip(pageSize * (pageNum - 1)).take(pageSize);
    entity.orderBy('entity.create_time', 'DESC');

    const [list, total] = await entity.getManyAndCount();
    return ResultData.ok({
      list: list.map((item) => this.formatJob(item)),
      total,
      page: pageNum,
      current_page: pageNum,
      size: pageSize,
      per_page: pageSize,
    });
  }

  /**
   * 获取定时任务详情
   * @param jobId - 任务 ID
   * @throws NotFoundException 任务不存在时
   * @returns 任务信息
   */
  async getJob(jobId: number) {
    const job = await this.jobRepository.findOne({ where: { jobId, del_flag: '0' } });
    if (!job) {
      throw new NotFoundException('任务不存在');
    }
    return ResultData.ok(this.formatJob(job));
  }

  /**
   * 创建定时任务
   * @param createJobDto - 创建参数
   * @throws BadRequestException 任务名称已存在时
   * @returns 操作结果
   */
  async create(createJobDto: CreateJobDto) {
    const exists = await this.jobRepository.findOne({
      where: { job_name: createJobDto.job_name, del_flag: '0' },
    });
    if (exists) {
      throw new BadRequestException('任务名称已存在');
    }

    const jobData = this.jobRepository.create({
      ...createJobDto,
      job_group: createJobDto.job_group || 'DEFAULT',
      misfire_policy: createJobDto.misfire_policy || '3',
      concurrent: createJobDto.concurrent || '1',
      status: createJobDto.status ?? '0',
      del_flag: '0',
    });
    const savedJob = await this.jobRepository.save(jobData);

    if (this.isJobActive(savedJob.status) && savedJob.cron_expression) {
      this.addCronJob(
        savedJob.job_name,
        savedJob.cron_expression,
        savedJob.invoke_target,
        savedJob.concurrent,
        savedJob.job_group,
      );
    }

    return ResultData.ok();
  }

  /**
   * 修改定时任务
   * @param jobId - 任务 ID
   * @param updateJobDto - 更新参数
   * @throws NotFoundException 任务不存在时
   * @throws BadRequestException 任务名称冲突时
   * @returns 操作结果
   */
  async update(jobId: number, updateJobDto: UpdateJobDto) {
    const job = await this.jobRepository.findOne({ where: { jobId, del_flag: '0' } });
    if (!job) {
      throw new NotFoundException('任务不存在');
    }

    if (updateJobDto.job_name && updateJobDto.job_name !== job.job_name) {
      const exists = await this.jobRepository.findOne({
        where: { job_name: updateJobDto.job_name, del_flag: '0' },
      });
      if (exists && exists.jobId !== jobId) {
        throw new BadRequestException('任务名称已存在');
      }
    }

    const nextName = updateJobDto.job_name || job.job_name;
    const nextExpression = updateJobDto.cron_expression ?? job.cron_expression;
    const nextTarget = updateJobDto.invoke_target ?? job.invoke_target;
    const nextStatus = updateJobDto.status ?? job.status;
    const nextConcurrent = updateJobDto.concurrent ?? job.concurrent;
    const nextGroup = updateJobDto.job_group ?? job.job_group;

    const scheduleChanged =
      nextName !== job.job_name ||
      nextExpression !== job.cron_expression ||
      nextTarget !== job.invoke_target ||
      nextStatus !== job.status ||
      nextConcurrent !== job.concurrent ||
      nextGroup !== job.job_group;

    if (scheduleChanged) {
      this.deleteCronJob(job.job_name);
      if (this.isJobActive(nextStatus) && nextExpression) {
        this.addCronJob(nextName, nextExpression, nextTarget, nextConcurrent, nextGroup);
      }
    }

    await this.jobRepository.update(jobId, updateJobDto as Partial<Job>);
    return ResultData.ok();
  }

  /**
   * 删除定时任务（逻辑删除）
   * @param jobIds - 任务 ID 或 ID 数组
   * @returns 操作结果
   */
  async remove(jobIds: number | number[]) {
    const ids = Array.isArray(jobIds) ? jobIds : [jobIds];
    const jobs = await this.jobRepository.findBy({ jobId: In(ids), del_flag: '0' });

    jobs.forEach((job) => this.deleteCronJob(job.job_name));

    await this.jobRepository.update(ids, { del_flag: '1' });
    return ResultData.ok();
  }

  /**
   * 立即执行一次定时任务
   * @param jobId - 任务 ID
   * @throws NotFoundException 任务不存在时
   * @returns 操作结果
   */
  async run(jobId: number) {
    const job = await this.jobRepository.findOne({ where: { jobId, del_flag: '0' } });
    if (!job) {
      throw new NotFoundException('任务不存在');
    }

    // 手动执行同样走分布式锁，避免与正在执行的周期任务并发叠加（大任务可能造成内存峰值）
    const executed = await this.runCronJobWithLock(
      job.job_name,
      job.invoke_target,
      job.concurrent,
      job.job_group,
      true,
    );

    if (!executed) {
      return ResultData.fail(429, '任务正在执行中，请稍后再试');
    }

    return ResultData.ok();
  }

  getRegisteredTasks() {
    return ResultData.ok(this.taskService.getTasks());
  }

  /**
   * 集群环境下通过 Redis 锁保证同一 Cron 仅一个 worker 执行
   * @param name 任务名称
   * @param invokeTarget 调用目标
   * @param concurrent 是否禁止并发执行（'1' 禁止）
   * @param jobGroup 任务分组
   * @param throwOnError 执行失败时是否向上抛出（手动触发场景需要把错误返回给调用方）
   * @returns true = 已获取锁并执行（执行失败时已记录日志）；false = 未获取锁被跳过
   */
  private async runCronJobWithLock(
    name: string,
    invokeTarget: string,
    concurrent: string,
    jobGroup: string,
    throwOnError = false,
  ): Promise<boolean> {
    const runningLockKey = `${CacheEnum.CRON_LOCK_KEY}${name}`;
    const tickLockKey = `${CacheEnum.CRON_LOCK_KEY}${name}:tick:${Math.floor(Date.now() / 60000)}`;
    const lockToken = `w${cluster.worker?.id ?? 0}:${process.pid}:${Date.now()}`;
    const forbidConcurrent = `${concurrent}` === '1';

    const lockKey = forbidConcurrent ? runningLockKey : tickLockKey;
    const lockTtl = forbidConcurrent ? CRON_LOCK_TTL_MS : 120_000;

    let acquired = false;
    try {
      acquired = await this.redisService.tryLock(lockKey, lockToken, lockTtl);
    } catch (error) {
      this.logger.error(`Cron job ${name} 获取分布式锁失败，跳过执行: ${(error as any)?.message}`);
      return false;
    }

    if (!acquired) {
      this.logger.debug(`Cron job ${name} 已由其他 worker 执行，W${cluster.worker?.id ?? '?'} 跳过`);
      return false;
    }

    try {
      this.logger.log(`Running job ${name} on W${cluster.worker?.id ?? '?'}:${process.pid}`);
      await this.taskService.executeTask(invokeTarget, name, jobGroup);
      return true;
    } catch (error) {
      // 周期任务执行失败只记录日志，避免 void 调用形成未处理的 Promise rejection
      this.logger.error(`Cron job ${name} 执行失败: ${(error as any)?.message}`);
      if (throwOnError) {
        throw error;
      }
      return true;
    } finally {
      if (forbidConcurrent) {
        try {
          await this.redisService.releaseLock(lockKey, lockToken);
        } catch (error) {
          this.logger.warn(`Cron job ${name} 释放分布式锁失败: ${(error as any)?.message}`);
        }
      }
    }
  }

  /**
   * 添加一个 Cron 定时任务到调度器
   * @param name - 任务名称
   * @param expression - Cron 表达式
   * @param invokeTarget - 调用目标方法名
   * @param concurrent - 是否禁止并发执行（'1' 禁止，'0' 允许）
   * @param jobGroup - 任务分组
   */
  addCronJob(
    name: string,
    expression: string,
    invokeTarget: string,
    concurrent = '1',
    jobGroup = 'DEFAULT',
  ) {
    if (!name || !expression) {
      this.logger.warn(`Invalid cron job: name="${name}", expression="${expression}"`);
      return;
    }
    if (this.schedulerRegistry.doesExist('cron', name)) {
      this.logger.warn(`Cron job ${name} already exists`);
      return;
    }

    this.cronJobMeta.set(name, { expression, invokeTarget, concurrent, jobGroup });

    const job = new CronJob(expression, () => {
      const meta = this.cronJobMeta.get(name);
      void this.runCronJobWithLock(
        name,
        meta?.invokeTarget || invokeTarget,
        meta?.concurrent || concurrent,
        meta?.jobGroup || jobGroup,
      );
    });

    this.schedulerRegistry.addCronJob(name, job as any);
    job.start();

    this.logger.log(`Cron job ${name} added with expression ${expression}`);
  }

  /**
   * 获取指定名称的 CronJob 实例
   * @param name - 任务名称
   * @returns CronJob 实例或 null（不存在时）
   */
  getCronJob(name: string): CronJob | null {
    try {
      return this.schedulerRegistry.getCronJob(name) as any;
    } catch {
      return null;
    }
  }

  /**
   * 删除指定名称的 Cron 定时任务
   * @param name - 任务名称
   */
  deleteCronJob(name: string) {
    try {
      if (this.schedulerRegistry.doesExist('cron', name)) {
        this.schedulerRegistry.deleteCronJob(name);
      }
      this.cronJobMeta.delete(name);
      this.logger.log(`Cron job ${name} deleted`);
    } catch {
      this.logger.warn(`Cron job ${name} not found`);
    }
  }

  /**
   * 导出定时任务列表为 xlsx 文件
   * @param res - Express 响应对象
   * @param body - 查询条件
   */
  async export(res: Response, body: ListJobDto) {
    delete body.pageNum;
    delete body.pageSize;
    const result = await this.list(body);
    const rows = result.data.list.map((item: any) => ({
      job_name: item.job_name,
      job_group: item.job_group,
      invoke_target: item.invoke_target,
      cron_expression: item.cron_expression,
      status: item.status === '0' ? '正常' : '暂停',
    }));
    const column = [
      { header: '任务名称', key: 'job_name', width: 30 },
      { header: '任务组名', key: 'job_group', width: 20 },
      { header: '调用目标', key: 'invoke_target', width: 50 },
      { header: 'Cron表达式', key: 'cron_expression', width: 30 },
      { header: '状态', key: 'status', width: 10 },
    ];
    await ExportTable({ data: rows, header: column }, res);
  }
}
