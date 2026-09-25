import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

export type PromptStage = string;

/** UI pattern 名 → YAML 根 key（对齐 Python select_prompt 第二参数） */
export const RAG_PATTERN_YAML_KEY: Record<string, string> = {
  NativeRAG: 'native_rag',
  MultiQuery: 'multi_query',
  RAGFusion: 'rag_fusion',
  SubQuestion: 'sub_question',
  StepBack: 'step_back',
  HYDE: 'hyde_rag',
  RoutingLogic: 'routing_logic',
  RoutingSemantic: 'routing_semantic',
  QueryConstruction: 'query_construction',
  MultiRepresentation: 'multi_representation',
  RAPTOR: 'raptor_rag',
  Graph: 'graph_rag',
  KeyWord: 'bm25_rag',
  Hybrid: 'hybrid_rag',
  KMean: 'kmean_rag',
  MMR: 'mmr_rag',
  Corrective: 'corrective_rag',
  SelfCheck: 'self_check_rag',
  Adaptive: 'adaptive_rag',
};

export const AGENT_PATTERN_YAML_KEY: Record<string, string> = {
  ReAct: 'react_agent',
  ReWOO: 'rewoo_agent',
  PlanExecute: 'plan_execute_agent',
  Reflection: 'reflection_agent',
  SelfDiscover: 'self_dicover_agent',
  Reflexion: 'reflexion_agent',
};

export const AGENT_PATTERN_GENERATE_STAGE: Record<string, string> = {
  ReAct: 'observe',
  ReWOO: 'solve',
  PlanExecute: 'replan',
  Reflection: 'generate',
  SelfDiscover: 'solve',
  Reflexion: 'execute',
};

@Injectable()
export class TaixuPromptService {
  private readonly logger = new Logger(TaixuPromptService.name);
  /** 提示词文件缓存；上限保护：提示词文件数量有限，超限时按插入顺序逐出，避免异常 fileName 造成无界增长 */
  private readonly cache = new Map<string, Record<string, Record<string, string>>>();
  private readonly maxCacheEntries = 64;

  private promptDirs() {
    return [
      path.join(process.cwd(), 'src', 'prompt'),
    ];
  }

  /**
   * 加载提示词 YAML 文件，优先从缓存读取。
   * @param fileName - 提示词文件名
   * @returns 解析后的 YAML 内容（模式名 → 阶段名 → 文本），或 null
   */
  loadPromptFile(fileName: string): Record<string, Record<string, string>> | null {
    if (!fileName) return null;
    const cached = this.cache.get(fileName);
    if (cached) return cached;

    const filePath = this.promptDirs()
      .map((dir) => path.join(dir, fileName))
      .find((candidate) => fs.existsSync(candidate));
    if (!filePath) {
      this.logger.error(`prompt file missing: ${fileName}; searched: ${this.promptDirs().join(', ')}`);
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = parseYaml(raw) as Record<string, Record<string, string>>;

    // 超限时逐出最早缓存的条目，保证缓存有界
    while (this.cache.size >= this.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
      this.logger.warn(`提示词缓存超过上限 ${this.maxCacheEntries}，已逐出 ${oldestKey}`);
    }

    this.cache.set(fileName, parsed);
    return parsed;
  }

  selectPrompt(fileName: string, patternKey: string) {
    const file = this.loadPromptFile(fileName);
    if (!file) return null;
    return file[patternKey] || null;
  }

  getStageText(fileName: string, patternKey: string, stage: PromptStage, fallback = '') {
    const block = this.selectPrompt(fileName, patternKey);
    const text = block?.[stage];
    return text?.trim() || fallback;
  }

  /**
   * 格式化模板字符串，将 {变量名} 替换为对应的变量值。
   * @param template - 模板字符串
   * @param vars - 变量映射表
   * @returns 格式化后的字符串
   */
  formatTemplate(template: string, vars: Record<string, string | number | undefined | null>) {
    return String(template || '').replace(/\{(\w+)\}/g, (_, key: string) => {
      const v = vars[key];
      return v === undefined || v === null ? '' : String(v);
    });
  }

  /**
   * 根据来源确定 RAG 提示词文件名。
   * @param source - 来源标识（advance/special/program/arxiv 等）
   * @returns 对应的 YAML 文件名
   */
  resolveRagPromptFile(source: string) {
    if (source === 'advance') return 'rag_advance.yml';
    if (source === 'special') return 'rag_special.yml';
    if (source === 'program') return 'rag_program.yml';
    if (source === 'arxiv') return 'rag_program.yml';
    return 'rag_pattern.yml';
  }

  /**
   * 根据来源和模式解析 RAG 的 YAML 键名。
   * @param source - 来源标识
   * @param pattern - RAG 模式名称
   * @returns 对应的 YAML 键
   */
  resolveRagYamlKey(source: string, pattern: string) {
    const p = String(pattern || '').trim();
    if (source === 'program') return 'program_rag';
    if (source === 'arxiv') return 'arxiv_rag';
    return RAG_PATTERN_YAML_KEY[p] || RAG_PATTERN_YAML_KEY.NativeRAG;
  }

  /**
   * 构建 RAG 生成阶段的提示词。根据 source 和 pattern 选择对应模板并填充变量。
   * @param args - 包含 source、pattern、context、question、memorys 的参数对象
   * @returns 构建完成的提示词字符串
   */
  buildRagGeneratePrompt(args: {
    source: string;
    pattern: string;
    context: string;
    question: string;
    memorys: string;
  }) {
    const file = this.resolveRagPromptFile(args.source);
    const key = this.resolveRagYamlKey(args.source, args.pattern);
    const stage = 'generate';
    const template = this.getStageText(file, key, stage);
    if (!template) {
      return this.formatTemplate(
        '请基于以下上下文内容回答问题：\n{context}\n\n问题：{question}\n\n历史记忆：{memorys}',
        args,
      );
    }
    const vars: Record<string, string> = {
      context: args.context,
      question: args.question,
      memorys: args.memorys,
      documents: args.context,
    };
    return this.formatTemplate(template, vars);
  }

  /**
   * 构建 RAG 指定阶段的提示词。
   * @param args - 包含 source、pattern、stage、vars 和可选 fallback 的参数对象
   * @returns 构建完成的提示词字符串
   */
  buildRagStagePrompt(args: {
    source: string;
    pattern: string;
    stage: string;
    vars: Record<string, string | number | undefined | null>;
    fallback?: string;
  }) {
    const file = this.resolveRagPromptFile(args.source);
    const key = this.resolveRagYamlKey(args.source, args.pattern);
    const template = this.getStageText(file, key, args.stage, args.fallback || '');
    return template ? this.formatTemplate(template, args.vars) : '';
  }

  /**
   * 构建智能体程序（Agent Program）的生成阶段提示词。
   * @param source - 来源类型：'search' 或 'topic'
   * @param args - 包含 context、question、memorys、topic 的参数对象
   * @returns 构建完成的提示词，若模板不存在则返回空字符串
   */
  buildAgentProgramGenerate(source: 'search' | 'topic', args: { context: string; question: string; memorys: string; topic?: string }) {
    const key = source === 'topic' ? 'topic_agent' : 'search_agent';
    const template = this.getStageText('agent_program.yml', key, 'generate');
    if (!template) return '';
    return this.formatTemplate(template, {
      context: args.context,
      question: args.question,
      memorys: args.memorys,
      topic: args.topic || args.question,
    });
  }

  buildAgentPatternPrompt(pattern: string, stage: string, vars: Record<string, string | number | undefined | null>) {
    const key = AGENT_PATTERN_YAML_KEY[pattern] || AGENT_PATTERN_YAML_KEY.ReAct;
    const template = this.getStageText('agent_pattern.yml', key, stage);
    return template ? this.formatTemplate(template, vars) : '';
  }

  /**
   * 构建答案生成（Answer Generate）的完整提示词。
   * 根据 pattern 使用对应的模式智能体生成阶段模板，填充全部可用变量。
   * @param pattern - 智能体模式名称
   * @param args - 包含 query、context、memorys、results 的参数对象
   * @returns 构建完成的提示词字符串
   */
  buildAnswerGeneratePrompt(pattern: string, args: { query: string; context: string; memorys: string; results?: string }) {
    const p = pattern || 'ReAct';
    const stage = AGENT_PATTERN_GENERATE_STAGE[p] || 'observe';
    const currentDate = new Date().toISOString().replace('T', ' ').slice(0, 19);
    return (
      this.buildAgentPatternPrompt(p, stage, {
        current_date: currentDate,
        query: args.query,
        question: args.query,
        input: args.query,
        context: args.context,
        results: args.results || args.context,
        memorys: args.memorys,
        format_instructions: '{"flag":"yes","result":"..."}',
        tool_descs: '',
        task: args.query,
        plan: args.context,
        documents: args.context,
        answer: '',
        order_plan: '',
      }) ||
      this.formatTemplate(
        '请根据上下文回答问题。\n上下文：{context}\n问题：{question}\n历史记忆：{memorys}',
        { context: args.context, question: args.query, memorys: args.memorys },
      )
    );
  }
}
