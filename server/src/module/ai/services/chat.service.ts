import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { randomUUID } from 'node:crypto';

import type { UserType } from '../../system/user/dto/user';
import { formatDateTime } from '../../../common/utils/index';
import { streamOpenAiChatCompletions } from '../providers/openai-stream.util';
import type { LlmStreamChunk, LlmStreamUsage } from '../providers/openai-stream.util';
import { LlmSemaphoreService } from './llm-semaphore.service';
import { AiStreamRegistry } from './ai-stream-registry.service';
import { AiChatSessionEntity } from '../entities/ai-chat-session.entity';
import { AiChatMessageEntity } from '../entities/ai-chat-message.entity';
import { AiConfigService } from './ai-config.service';
import { ContextBuilderService } from './context-builder.service';
import { SessionSummaryService } from './session-summary.service';
import { buildProviderExtraBody } from '../providers/llm-provider.util';
import type {
  AiWsChatSendData,
  AiWsMessageDoneData,
  AiWsMessageStartData,
  AiWsServerEvent,
  AiWsTokenData,
} from '../ai.types';

export type WsEmitFn = (event: AiWsServerEvent, data: unknown) => void;

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @InjectRepository(AiChatSessionEntity)
    private readonly sessionRepo: Repository<AiChatSessionEntity>,
    @InjectRepository(AiChatMessageEntity)
    private readonly messageRepo: Repository<AiChatMessageEntity>,
    private readonly aiConfigService: AiConfigService,
    private readonly semaphore: LlmSemaphoreService,
    private readonly streamRegistry: AiStreamRegistry,
    private readonly contextBuilder: ContextBuilderService,
    private readonly sessionSummaryService: SessionSummaryService,
  ) {}

  private authCtx(session: UserType) {
    return {
      userId: session.userId,
      tenantId: session.tenantId ?? 0,
      userName: session.userName ?? session.user?.username ?? '',
    };
  }

  /**
   * 创建新的聊天会话，分配默认模型并保存至数据库
   *
   * @param session - 当前用户会话对象
   * @param body - 创建参数，包含可选的 agent_id、model_id、title
   * @returns 包含 session_uuid、title、agent_id、default_model_id、create_time 的对象
   */
  async createSession(session: UserType, body: { agent_id?: string; model_id?: string; title?: string }) {
    const { userId, tenantId } = this.authCtx(session);
    const defaultModelId =
      body.model_id ?? (await this.aiConfigService.getDefaultModelId(tenantId));
    if (!defaultModelId) {
      throw new BadRequestException('未配置可用模型，请在管理后台配置 AI 供应商与模型');
    }

    let agentId = body.agent_id ?? null;
    if (agentId) {
      const agent = await this.aiConfigService.getAgent(agentId, tenantId);
      if (!agent) throw new BadRequestException('Agent 不存在');
    }

    const entity = await this.sessionRepo.save(
      this.sessionRepo.create({
        sessionUuid: randomUUID(),
        userId,
        tenantId,
        agentId,
        title: body.title?.trim() || '新对话',
        defaultModelId,
        messageCount: 0,
        status: '0',
        createdBy: userId,
        updatedBy: userId,
      }),
    );

    return {
      session_uuid: entity.sessionUuid,
      title: entity.title,
      agent_id: entity.agentId,
      default_model_id: entity.defaultModelId,
      create_time: formatDateTime(entity.createTime),
    };
  }

  /**
   * 分页查询当前用户的会话列表，按最后消息时间倒序排列
   *
   * @param session - 当前用户会话对象
   * @param query - 分页查询参数，包含 page（页码）和 limit（每页条数）
   * @returns 包含会话列表和总数量的对象
   */
  async listSessions(session: UserType, query: { page?: number; limit?: number }) {
    const { userId, tenantId } = this.authCtx(session);
    const page = Number(query.page || 1);
    const limit = Number(query.limit || 20);

    const [list, total] = await this.sessionRepo.findAndCount({
      where: { userId, tenantId, deleteTime: IsNull() },
      order: { lastMessageAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      list: list.map((item) => ({
        session_uuid: item.sessionUuid,
        title: item.title,
        agent_id: item.agentId,
        default_model_id: item.defaultModelId,
        message_count: item.messageCount,
        last_message_at: item.lastMessageAt ? formatDateTime(item.lastMessageAt) : null,
        create_time: formatDateTime(item.createTime),
      })),
      total,
    };
  }

  /**
   * 更新会话的默认模型
   *
   * @param session - 当前用户会话对象
   * @param sessionUuid - 会话 UUID
   * @param modelId - 新的模型 ID
   * @returns 包含 session_uuid 和 default_model_id 的对象
   */
  async updateSessionModel(session: UserType, sessionUuid: string, modelId: string) {
    const owned = await this.getOwnedSession(session, sessionUuid);
    await this.aiConfigService.resolveModel(modelId, owned.tenantId);
    owned.defaultModelId = modelId;
    owned.updatedBy = owned.userId;
    await this.sessionRepo.save(owned);
    return { session_uuid: owned.sessionUuid, default_model_id: modelId };
  }

  /**
   * 更新会话标题
   *
   * @param session - 当前用户会话对象
   * @param sessionUuid - 会话 UUID
   * @param title - 新标题（不能为空，最长 200 字符）
   * @returns 包含 session_uuid 和 title 的对象
   */
  async updateSessionTitle(session: UserType, sessionUuid: string, title: string) {
    const owned = await this.getOwnedSession(session, sessionUuid);
    const trimmed = title?.trim();
    if (!trimmed) throw new BadRequestException('标题不能为空');
    owned.title = trimmed.slice(0, 200);
    owned.updatedBy = owned.userId;
    await this.sessionRepo.save(owned);
    return { session_uuid: owned.sessionUuid, title: owned.title };
  }

  /**
   * 获取会话的消息历史，并附带模型选项、会话统计和上下文窗口信息
   *
   * @param session - 当前用户会话对象
   * @param sessionUuid - 会话 UUID
   * @returns 包含会话元数据、统计数据及消息列表的对象
   */
  async listMessages(session: UserType, sessionUuid: string) {
    const owned = await this.getOwnedSession(session, sessionUuid);
    const messages = await this.messageRepo.find({
      where: { sessionId: owned.id, deleteTime: IsNull() },
      order: { seq: 'ASC' },
    });

    const modelIds = [...new Set(messages.map((m) => m.modelId).filter(Boolean))] as string[];
    const modelOptions = await this.aiConfigService.listModelOptions(owned.tenantId);
    const modelMap = new Map(modelOptions.map((m) => [m.id, m]));
    const defaultModel = owned.defaultModelId ? modelMap.get(owned.defaultModelId) : null;
    const sessionStats = await this.buildSessionStats(owned.id, owned.messageCount);
    const compactThreshold = await this.aiConfigService.getContextCompactThreshold();

    return {
      session_uuid: owned.sessionUuid,
      default_model_id: owned.defaultModelId,
      stats: {
        total_tokens: sessionStats.totalTokens,
        rounds: sessionStats.rounds,
        context_window: defaultModel?.context_window ?? 32000,
        compact_threshold: compactThreshold,
      },
      list: messages
        .filter((m) => m.role !== 'system')
        .map((m) => {
          const model = m.modelId ? modelMap.get(m.modelId) : null;
          return {
            message_uuid: m.messageUuid,
            role: m.role,
            content: m.content ?? '',
            content_format: m.contentFormat,
            status: m.status,
            model_id: m.modelId,
            model_name: model?.name ?? null,
            provider_name: model?.provider_name ?? null,
            prompt_tokens: m.promptTokens,
            completion_tokens: m.completionTokens,
            total_tokens: m.totalTokens,
            latency_ms: m.latencyMs,
            create_time: formatDateTime(m.createTime),
          };
        }),
    };
  }

  async deleteSession(session: UserType, sessionUuid: string) {
    const owned = await this.getOwnedSession(session, sessionUuid);
    await this.sessionRepo.softDelete({ id: owned.id });
    await this.messageRepo.softDelete({ sessionId: owned.id });
    return { session_uuid: sessionUuid };
  }

  /**
   * 中止本地的流式生成请求，支持按消息 UUID 或会话 UUID 取消
   *
   * @param messageUuid - 消息 UUID（可选），精确中止指定消息的流
   * @param sessionUuid - 会话 UUID（可选），中止该会话下的所有流
   * @returns 是否成功中止了至少一个流
   */
  abortLocalStream(messageUuid?: string, sessionUuid?: string): boolean {
    return this.streamRegistry.abort(messageUuid, sessionUuid);
  }

  /**
   * 处理聊天消息发送，构建上下文、调用 LLM 流式接口并实时推送 token 至客户端
   *
   * @param session - 当前用户会话对象
   * @param payload - 聊天发送负载，包含会话 UUID、消息内容、模型 ID、温度参数等
   * @param emit - WebSocket 事件推送回调函数
   */
  async handleChatSend(session: UserType, payload: AiWsChatSendData, emit: WsEmitFn) {
    if (!(await this.aiConfigService.isAiEnabled())) {
      throw new BadRequestException('AI 助手未启用');
    }

    const content = payload.content?.trim();
    if (!content) throw new BadRequestException('消息内容不能为空');

    const owned = await this.getOwnedSession(session, payload.session_uuid);
    const modelId = payload.model_id ?? owned.defaultModelId;
    if (!modelId) throw new BadRequestException('未选择模型');

    const resolved = await this.aiConfigService.resolveModel(modelId, owned.tenantId);
    const agent = owned.agentId
      ? await this.aiConfigService.getAgent(owned.agentId, owned.tenantId)
      : null;

    const nextSeq = owned.messageCount + 1;
    const userMsg = await this.messageRepo.save(
      this.messageRepo.create({
        messageUuid: randomUUID(),
        sessionId: owned.id,
        userId: owned.userId,
        tenantId: owned.tenantId,
        role: 'user',
        content,
        contentFormat: 'markdown',
        seq: nextSeq,
        status: 'completed',
        createdBy: owned.userId,
      }),
    );

    emit('chat.user_message', {
      session_uuid: owned.sessionUuid,
      message_uuid: userMsg.messageUuid,
      content,
    });

    const assistantMsg = await this.messageRepo.save(
      this.messageRepo.create({
        messageUuid: randomUUID(),
        sessionId: owned.id,
        userId: owned.userId,
        tenantId: owned.tenantId,
        role: 'assistant',
        content: '',
        contentFormat: 'markdown',
        modelId: resolved.model.id,
        providerId: resolved.provider.id,
        seq: nextSeq + 1,
        status: 'streaming',
        requestParams: {
          model_id: resolved.model.id,
          model_code: resolved.model.modelCode,
          provider_id: resolved.provider.id,
          temperature: payload.temperature ?? Number(resolved.model.defaultTemperature),
          max_output_tokens: resolved.model.maxOutputTokens,
        },
        metadata: {
          model_name: resolved.model.name,
          provider_name: resolved.provider.name,
        },
        createdBy: owned.userId,
      }),
    );

    const startData: AiWsMessageStartData = {
      session_uuid: owned.sessionUuid,
      message_uuid: assistantMsg.messageUuid,
      model_id: resolved.model.id,
      model_name: resolved.model.name,
      provider_name: resolved.provider.name,
    };
    emit('chat.message_start', startData);

    const abort = new AbortController();
    const startedAt = Date.now();
    let fullContent = '';

    // 先获取并发槽位再登记：acquire 超限会抛错，必须发生在登记之前，
    // 否则被拒请求会在登记表里残留一个永不释放的条目（历史上导致登记表无界增长）
    this.semaphore.acquire();
    this.streamRegistry.register(assistantMsg.messageUuid, {
      abort,
      sessionUuid: owned.sessionUuid,
    });

    try {
      const built = await this.contextBuilder.buildMessages({
        sessionId: owned.id,
        userContent: content,
        agent,
        sessionSummary: owned.summary,
        summaryUpToSeq: owned.summaryUpToSeq,
        tenantId: owned.tenantId,
        userName: session.userName,
        contextWindow: resolved.model.contextWindow,
        maxOutputTokens: resolved.model.maxOutputTokens,
      });

      const temperature =
        payload.temperature ??
        (agent?.temperature != null ? Number(agent.temperature) : Number(resolved.model.defaultTemperature));

      let usage: LlmStreamUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      const stream = streamOpenAiChatCompletions({
        baseUrl: resolved.provider.baseUrl,
        apiKey: resolved.apiKey,
        model: resolved.model.modelCode,
        messages: built.messages,
        temperature,
        maxTokens: resolved.model.maxOutputTokens,
        signal: abort.signal,
        extraHeaders: resolved.provider.extraHeaders ?? undefined,
        extraBody: buildProviderExtraBody(resolved.provider),
      });

      while (true) {
        const result = await stream.next();
        if (result.done) {
          if (result.value) usage = result.value;
          break;
        }
        const chunk = result.value as LlmStreamChunk;
        if (chunk.delta) {
          fullContent += chunk.delta;
          const tokenData: AiWsTokenData = {
            session_uuid: owned.sessionUuid,
            message_uuid: assistantMsg.messageUuid,
            delta: chunk.delta,
          };
          emit('chat.token', tokenData);
        }
      }

      assistantMsg.content = fullContent;
      assistantMsg.status = 'completed';
      assistantMsg.promptTokens = usage.promptTokens;
      assistantMsg.completionTokens = usage.completionTokens;
      assistantMsg.totalTokens = usage.totalTokens;
      assistantMsg.latencyMs = Date.now() - startedAt;
      assistantMsg.metadata = {
        ...(assistantMsg.metadata ?? {}),
        model_name: resolved.model.name,
        provider_name: resolved.provider.name,
        prompt_cache_hit_tokens: usage.promptCacheHitTokens ?? 0,
        prompt_cache_miss_tokens: usage.promptCacheMissTokens ?? 0,
        context_ratio: built.contextRatio,
        estimated_prompt_tokens: built.estimatedPromptTokens,
      };
      await this.messageRepo.save(assistantMsg);

      owned.messageCount += 2;
      owned.lastMessageAt = new Date();
      owned.defaultModelId = modelId;
      if (owned.messageCount === 2 && owned.title === '新对话') {
        owned.title = content.slice(0, 40);
      }
      owned.updatedBy = owned.userId;
      await this.sessionRepo.save(owned);

      const compactThreshold = await this.aiConfigService.getContextCompactThreshold();
      const sessionStats = await this.buildSessionStats(owned.id, owned.messageCount);

      this.sessionSummaryService.scheduleSummarize(
        owned.id,
        owned.tenantId,
        modelId,
        built.contextRatio,
      );

      const cacheHitRate =
        usage.promptTokens > 0
          ? Math.round(((usage.promptCacheHitTokens ?? 0) / usage.promptTokens) * 100)
          : null;

      const doneData: AiWsMessageDoneData = {
        session_uuid: owned.sessionUuid,
        message_uuid: assistantMsg.messageUuid,
        content: fullContent,
        usage: {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens,
          prompt_cache_hit_tokens: usage.promptCacheHitTokens,
          prompt_cache_miss_tokens: usage.promptCacheMissTokens,
        },
        context: {
          ratio: built.contextRatio,
          estimated_prompt_tokens: built.estimatedPromptTokens,
          context_window: resolved.model.contextWindow,
          history_rounds: built.historyRounds,
          compact_threshold: compactThreshold,
        },
        session_stats: {
          total_tokens: sessionStats.totalTokens,
          rounds: sessionStats.rounds,
          cache_hit_rate: cacheHitRate,
        },
        latency_ms: assistantMsg.latencyMs,
      };
      emit('chat.message_done', doneData);
    } catch (err: any) {
      const stopped = abort.signal.aborted || err?.name === 'AbortError';
      assistantMsg.content = fullContent;
      assistantMsg.status = stopped ? 'stopped' : 'error';
      assistantMsg.errorMessage = err?.message?.slice(0, 500) ?? '生成失败';
      assistantMsg.latencyMs = Date.now() - startedAt;
      await this.messageRepo.save(assistantMsg);

      if (!stopped) {
        emit('chat.error', { code: 500, message: assistantMsg.errorMessage });
      } else {
        emit('chat.message_done', {
          session_uuid: owned.sessionUuid,
          message_uuid: assistantMsg.messageUuid,
          content: fullContent,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          latency_ms: assistantMsg.latencyMs,
        });
      }
      this.logger.warn(`chat stream failed: ${assistantMsg.errorMessage}`);
    } finally {
      this.semaphore.release();
      this.streamRegistry.unregister(assistantMsg.messageUuid);
    }
  }

  /**
   * 获取当前用户拥有的会话实体，若不存在或无权访问则抛出异常
   *
   * @param session - 当前用户会话对象
   * @param sessionUuid - 会话 UUID
   * @returns 会话实体对象
   * @throws NotFoundException 当会话不存在或不属于当前用户时
   */
  private async getOwnedSession(session: UserType, sessionUuid: string): Promise<AiChatSessionEntity> {
    const { userId, tenantId } = this.authCtx(session);
    const owned = await this.sessionRepo.findOne({
      where: { sessionUuid, userId, tenantId, deleteTime: IsNull() },
    });
    if (!owned) {
      throw new NotFoundException('会话不存在或无权访问');
    }
    return owned;
  }

  /**
   * 构建会话的 Token 消耗统计信息，包括总 Token 数、Prompt Token 数和对话轮次
   *
   * @param sessionId - 会话数据库 ID
   * @param messageCount - 当前消息总数
   * @returns 包含 totalTokens、promptTokens 和 rounds 的统计对象
   */
  private async buildSessionStats(sessionId: string, messageCount: number) {
    const row = await this.messageRepo
      .createQueryBuilder('m')
      .select('COALESCE(SUM(m.totalTokens), 0)', 'total')
      .addSelect('COALESCE(SUM(m.promptTokens), 0)', 'prompt')
      .where('m.sessionId = :sessionId', { sessionId })
      .andWhere('m.deleteTime IS NULL')
      .getRawOne<{ total: string; prompt: string }>();

    return {
      totalTokens: Number(row?.total ?? 0),
      promptTokens: Number(row?.prompt ?? 0),
      rounds: Math.floor(messageCount / 2),
    };
  }
}
