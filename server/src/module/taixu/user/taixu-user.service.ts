import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { In, IsNull, Repository } from 'typeorm';
import { DataSource } from 'typeorm';
import { formatDateTime } from '../../../common/utils';
import { getTenantId } from '../../../common/utils/tenant.util';
import { UserEntity } from '../../system/user/entities/sys-user.entity';
import { SysUserTenantEntity } from '../../system/user/entities/user-tenant.entity';
import { TaixuUserProfileEntity } from './entities/taixu-user-profile.entity';
import {
  TaixuUserCreateDto,
  TaixuUserDeleteDto,
  TaixuUserPageDto,
  TaixuUserSelectDto,
  TaixuUserUpdateDto,
} from './dto';

@Injectable()
export class TaixuUserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(SysUserTenantEntity)
    private readonly userTenantRepo: Repository<SysUserTenantEntity>,
    @InjectRepository(TaixuUserProfileEntity)
    private readonly profileRepo: Repository<TaixuUserProfileEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  private requireTenantId(): number {
    const tenantId = getTenantId();
    if (!tenantId) throw new UnauthorizedException('Unauthorized');
    return tenantId;
  }

  /**
   * 将用户实体转换为前端展示行数据
   * @param entity - 用户实体对象
   * @param profile - 可选的用户档案信息
   * @returns 包含用户ID、租户ID、用户名、手机号、邮箱、创建时间、简历、头像等信息的行数据对象
   */
  private toRow(entity: UserEntity, profile?: TaixuUserProfileEntity | null) {
    return {
      id: String(entity.id),
      tenant_id: this.requireTenantId(),
      user_name: entity.username,
      password: null,
      phone_number: entity.phone,
      email: entity.email,
      create_time: formatDateTime(entity.createTime),
      resume: profile?.resume ?? null,
      photo: profile?.photo ?? null,
      visit: 0,
    };
  }

  /**
   * 分页查询用户列表
   * @param dto - 分页查询参数，包含当前页、每页条数、用户名、手机号、创建时间等过滤条件
   * @returns 返回包含 total（总数）、pages（总页数）、records（用户行数据数组）的分页结果
   */
  async page(dto: TaixuUserPageDto) {
    const tenantId = this.requireTenantId();
    const currentPage = Math.max(1, Number(dto.current_page ?? 1));
    const pageSize = Math.max(1, Math.min(200, Number(dto.page_size ?? 10)));

    const qb = this.userRepo.createQueryBuilder('u');
    qb.where('u.deleteTime IS NULL');
    qb.innerJoin(
      SysUserTenantEntity,
      'ut',
      'ut.userId = u.id AND ut.tenantId = :tenantId AND ut.deleteTime IS NULL',
      { tenantId },
    );
    if (dto.userName) {
      qb.andWhere('u.username LIKE :userName', { userName: `%${dto.userName}%` });
    }
    if (dto.phoneNumber) {
      qb.andWhere('u.phone LIKE :phoneNumber', { phoneNumber: `%${dto.phoneNumber}%` });
    }
    if (dto.createTime) {
      qb.andWhere('DATE(u.createTime) = :createDate', { createDate: dto.createTime });
    }

    qb.orderBy('u.createTime', 'DESC');
    qb.skip((currentPage - 1) * pageSize).take(pageSize);
    const [list, total] = await qb.getManyAndCount();
    const pages = Math.ceil(total / pageSize);

    const userIds = list.map((u) => u.id);
    const profiles = userIds.length
      ? await this.profileRepo.find({
          where: {
            tenantId,
            userId: In(userIds),
            deleteTime: IsNull(),
          },
        })
      : [];
    const profileMap = new Map<number, TaixuUserProfileEntity>();
    profiles.forEach((p) => profileMap.set(p.userId, p));

    return {
      total,
      pages,
      records: list.map((row) => this.toRow(row, profileMap.get(row.id))),
    };
  }

  /**
   * 创建新用户（事务操作：同时创建用户、租户关联和用户档案）
   * @param dto - 创建用户参数，包含用户名、密码、手机号、邮箱、简历、头像等信息
   * @returns 无返回值
   */
  async create(dto: TaixuUserCreateDto) {
    const tenantId = this.requireTenantId();

    const salt = bcrypt.genSaltSync(10);
    const plainPwd = dto.password || '123456';
    const hashedPwd = bcrypt.hashSync(plainPwd, salt);

    await this.dataSource.transaction(async (manager) => {
      const user = manager.create(UserEntity, {
        username: dto.user_name || '',
        password: hashedPwd,
        realname: dto.user_name || '',
        phone: dto.phone_number || '',
        email: dto.email || '',
        remark: (dto.resume || '').slice(0, 255),
      });
      const saved = await manager.save(UserEntity, user);

      const link = manager.create(SysUserTenantEntity, {
        userId: saved.id,
        tenantId,
        isDefault: 0,
        joinTime: new Date(),
      });
      await manager.save(SysUserTenantEntity, link);

      const profile = manager.create(TaixuUserProfileEntity, {
        tenantId,
        userId: saved.id,
        resume: dto.resume ?? null,
        photo: dto.photo ?? null,
      });
      await manager.save(TaixuUserProfileEntity, profile);
    });
  }

  /**
   * 更新用户信息
   * @param dto - 更新用户参数，包含用户ID及可选更新的用户名、手机号、邮箱、密码、简历、头像等字段
   * @returns 无返回值
   */
  async update(dto: TaixuUserUpdateDto) {
    const tenantId = this.requireTenantId();
    const userId = Number(dto.id);

    const link = await this.userTenantRepo.findOne({
      where: { tenantId, userId, deleteTime: IsNull() },
    });
    if (!link) throw new UnauthorizedException('Unauthorized');

    const patch: Partial<UserEntity> = {};
    if (dto.user_name !== undefined) {
      patch.username = dto.user_name || '';
      patch.realname = dto.user_name || '';
    }
    if (dto.phone_number !== undefined) patch.phone = dto.phone_number || '';
    if (dto.email !== undefined) patch.email = dto.email || '';
    if (dto.resume !== undefined) patch.remark = (dto.resume || '').slice(0, 255);
    if (dto.password !== undefined) {
      const salt = bcrypt.genSaltSync(10);
      patch.password = bcrypt.hashSync(dto.password || '123456', salt);
    }

    await this.userRepo.update({ id: userId }, patch);

    await this.upsertProfile(tenantId, userId, dto.resume, dto.photo);
  }

  /**
   * 删除用户（软删除：同时删除租户关联和用户档案，若无其他租户关联则删除用户本身）
   * @param dto - 删除用户参数，包含以逗号分隔的用户ID字符串
   * @returns 无返回值
   */
  async remove(dto: TaixuUserDeleteDto) {
    const tenantId = this.requireTenantId();
    const ids = String(dto.ids || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (!ids.length) return;

    const userIds = ids.map((id) => Number(id)).filter((id) => Number.isFinite(id));
    if (!userIds.length) return;

    const links = await this.userTenantRepo.find({
      where: { tenantId, userId: In(userIds), deleteTime: IsNull() },
    });
    if (links.length) {
      await this.userTenantRepo.softDelete(links.map((l) => l.id));
    }

    const profiles = await this.profileRepo.find({
      where: { tenantId, userId: In(userIds), deleteTime: IsNull() },
    });
    if (profiles.length) {
      await this.profileRepo.softDelete(profiles.map((p) => p.id));
    }

    for (const userId of userIds) {
      const remain = await this.userTenantRepo.count({ where: { userId, deleteTime: IsNull() } });
      if (!remain) {
        await this.userRepo.softDelete(userId);
      }
    }
  }

  /**
   * 根据用户名和密码查询并验证用户
   * @param dto - 查询参数，包含用户名和密码
   * @returns 验证通过则返回用户行数据，否则返回 null
   */
  async select(dto: TaixuUserSelectDto) {
    const tenantId = this.requireTenantId();
    if (!dto.user_name || !dto.password) return null;
    const user = await this.userRepo.findOne({
      where: { username: dto.user_name, deleteTime: IsNull() },
      select: {
        id: true,
        username: true,
        password: true,
        phone: true,
        email: true,
        createTime: true,
      } as any,
    });
    if (!user) return null;
    const link = await this.userTenantRepo.findOne({
      where: { tenantId, userId: user.id, deleteTime: IsNull() },
    });
    if (!link) return null;
    const ok = bcrypt.compareSync(dto.password, user.password);
    if (!ok) return null;

    const profile = await this.profileRepo.findOne({
      where: { tenantId, userId: user.id, deleteTime: IsNull() },
    });
    return this.toRow(user, profile);
  }

  /**
   * 创建或更新用户档案信息
   * @param tenantId - 租户ID
   * @param userId - 用户ID
   * @param resume - 可选，个人简介
   * @param photo - 可选，头像信息
   * @returns 无返回值
   */
  private async upsertProfile(tenantId: number, userId: number, resume?: string, photo?: string) {
    const existing = await this.profileRepo.findOne({
      where: { tenantId, userId, deleteTime: IsNull() },
    });
    if (!existing) {
      await this.profileRepo.save(
        this.profileRepo.create({
          tenantId,
          userId,
          resume: resume ?? null,
          photo: photo ?? null,
        }),
      );
      return;
    }
    await this.profileRepo.update(
      { id: existing.id },
      {
        ...(resume !== undefined ? { resume: resume ?? null } : {}),
        ...(photo !== undefined ? { photo: photo ?? null } : {}),
      },
    );
  }
}
