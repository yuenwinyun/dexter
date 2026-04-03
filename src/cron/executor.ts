import { appendFileSync, readdirSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { runAgentForMessage } from '../gateway/agent-runner.js';
import {
  evaluateSuppression,
  HEARTBEAT_OK_TOKEN,
  type SuppressionState,
} from '../gateway/heartbeat/suppression.js';
import { assertOutboundAllowed, sendMessageWhatsApp } from '../gateway/channels/whatsapp/index.js';
import { resolveSessionStorePath, loadSessionStore, type SessionEntry } from '../gateway/sessions/store.js';
import { cleanMarkdownForWhatsApp } from '../gateway/utils.js';
import { getSetting } from '../utils/config.js';
import { dexterPath } from '../utils/paths.js';
import { saveCronStore } from './store.js';
import { computeNextRunAtMs } from './schedule.js';
import type { ActiveHours, CronJob, CronStore } from './types.js';
import { loadPortfolioConfig, getPortfolioById } from '../portfolio/config.js';
import { resolveEffectiveModel } from '../portfolio/model-resolution.js';
import { runPortfolioAnalysis } from '../portfolio/runner.js';
import type { PortfolioAnalysisResult } from '../portfolio/types.js';
import type { ConversationEntry } from '../utils/long-term-chat-history.js';

const LOG_PATH = dexterPath('gateway-debug.log');

function debugLog(msg: string) {
  appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
}

// Per-job suppression state (in memory, resets on process restart)
const suppressionStates = new Map<string, SuppressionState>();

const BACKOFF_SCHEDULE_MS = [
  30_000,      // 1st error → 30s
  60_000,      // 2nd → 1 min
  5 * 60_000,  // 3rd → 5 min
  15 * 60_000, // 4th → 15 min
  60 * 60_000, // 5th+ → 60 min
];

const MAX_AT_RETRIES = 3;
const SCHEDULE_ERROR_DISABLE_THRESHOLD = 3;

function escapeLarkText(input: string): string {
  return input.replace(/\r\n/g, '\n').trim();
}

function formatPortfolioDeliveryMessage(params: {
  portfolioName: string;
  portfolioId: string;
  trigger: 'manual' | 'manual-job' | 'scheduled';
  result: {
    ok: boolean;
    summary: {
      headline: string;
      overall_view: string;
      top_risks: string[];
      top_opportunities: string[];
      follow_ups: string[];
    };
    final_text: string;
  };
  runId: string;
  detailDocUrl?: string;
}): string {
  const riskItems = params.result.summary.top_risks.length
    ? params.result.summary.top_risks.map((item) => `- ${item}`).join('\n')
    : '- (none)';
  const oppItems = params.result.summary.top_opportunities.length
    ? params.result.summary.top_opportunities.map((item) => `- ${item}`).join('\n')
    : '- (none)';
  const followItems = params.result.summary.follow_ups.length
    ? params.result.summary.follow_ups.map((item) => `- ${item}`).join('\n')
    : '- (none)';

  const baseMessage = escapeLarkText(`Portfolio update (${params.trigger})

${params.portfolioName} (${params.portfolioId})
Run: ${params.runId}
Status: ${params.result.ok ? 'ok' : 'attention'}

Headline: ${params.result.summary.headline}

${params.result.summary.overall_view}

Top risks:
${riskItems}

Top opportunities:
${oppItems}

Follow-ups:
${followItems}

${params.result.final_text}`);

  const docLine = params.detailDocUrl
    ? `\n\n详情报告: ${params.detailDocUrl}`
    : '';

  return `${baseMessage}${docLine}`;
}

function sendPortfolioMessageToLark(params: { chatId: string; text: string; identity?: 'bot' | 'user' }): Promise<void> {
  const args = [
    'im',
    '+messages-send',
    '--chat-id',
    params.chatId,
    '--as',
    params.identity ?? 'bot',
    '--text',
    params.text,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('lark-cli', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = (stdout + stderr).trim() || `lark-cli exited with code ${code}`;
      reject(new Error(detail));
    });
  });
}

function runLarkCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('lark-cli', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve((stdout + stderr).trim());
        return;
      }
      const detail = (stdout + stderr).trim() || `lark-cli exited with code ${code}`;
      reject(new Error(detail));
    });
  });
}

function parseLarkResponse<T = unknown>(output: string): T {
  const match = output.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`Unable to parse lark-cli JSON response: ${output}`);
  }

  return JSON.parse(match[0]) as T;
}

function formatPortfolioDeliveryDocument(params: {
  portfolioName: string;
  portfolioId: string;
  trigger: 'manual' | 'manual-job' | 'scheduled';
  result: {
    ok: boolean;
    summary: {
      headline: string;
      overall_view: string;
      top_risks: string[];
      top_opportunities: string[];
      follow_ups: string[];
    };
    holdings?: Array<{ ticker: string; status: string; weight?: number }>;
    final_text: string;
  };
  runId: string;
  runAt: string;
}): string {
  const risks = params.result.summary.top_risks.length
    ? params.result.summary.top_risks.map((item) => `- ${item}`).join('\n')
    : '- (none)';
  const opportunities = params.result.summary.top_opportunities.length
    ? params.result.summary.top_opportunities.map((item) => `- ${item}`).join('\n')
    : '- (none)';
  const followUps = params.result.summary.follow_ups.length
    ? params.result.summary.follow_ups.map((item) => `- ${item}`).join('\n')
    : '- (none)';

  const errorHoldings = (params.result.holdings ?? []).filter((holding) => holding.status === 'error');
  const holdings = (params.result.holdings ?? []).length
    ? params.result.holdings
      ?.map((holding) => {
        const label = `${holding.ticker}${holding.weight !== undefined ? ` (${(holding.weight * 100).toFixed(1)}%)` : ''}`;
        const commentary = holding.highlights?.find((item) => item && item.trim().length > 0)
          ?? holding.news?.find((item) => item && item.trim().length > 0)
          ?? holding.events?.find((item) => item && item.trim().length > 0)
          ?? (holding.status === 'error'
            ? (holding.errors?.find((item) => item && item.trim().length > 0)
              ? `信息待补充（${holding.errors.find((item) => item && item.trim().length > 0)}）`
              : '信息待补充')
            : holding.status === 'notable'
              ? '有需重点关注的变化'
              : '暂无明显新增事项');
        return `- ${label}: ${commentary}`;
      })
      .join('\n')
    : '- (no holdings)';
  const limitationSummary = errorHoldings.length >= Math.max(2, Math.ceil(((params.result.holdings ?? []).length || 0) * 0.4))
    ? `\n\n### 信息限制说明\n- 本次有 ${errorHoldings.length}/${(params.result.holdings ?? []).length} 个持仓未完成完整当日核查\n- 这通常意味着工具/数据可用性不足，而不是这些持仓本身出现异常\n- 今日事件级判断应降级为结构性判断，避免把“无法核查”误读成“明确利空”`
    : '';

  return escapeLarkText(`## ${params.portfolioName}（${params.portfolioId}）\n\n` +
    `- **Run:** ${params.runId}\n` +
    `- **触发方式:** ${params.trigger}\n` +
    `- **时间:** ${params.runAt}\n` +
    `- **状态:** ${params.result.ok ? '成功' : '失败'}\n\n` +
    `### 组合观点\n${params.result.summary.headline}\n\n` +
    `${params.result.summary.overall_view}\n\n` +
    `### Top risks\n${risks}\n\n` +
    `### Top opportunities\n${opportunities}\n\n` +
    `### Follow-ups\n${followUps}\n\n` +
    `### 核心持仓\n${holdings}` +
    `${limitationSummary}\n\n` +
    `### 结论\n${params.result.final_text}`);
}

type PortfolioQualityCheckResult = {
  ok: boolean;
  score: number;
  reasons: string[];
  summary: string;
};

function runPortfolioQualityCheck(result: {
  summary: {
    headline: string;
    overall_view: string;
    top_risks: string[];
    top_opportunities: string[];
    follow_ups: string[];
  };
  final_text: string;
}): PortfolioQualityCheckResult {
  const reasons: string[] = [];
  let score = 100;

  if (!result.summary.headline || result.summary.headline.trim().length < 20) {
    score -= 20;
    reasons.push('headline 太短，信息密度不够');
  }

  if (!result.summary.overall_view || result.summary.overall_view.trim().length < 120) {
    score -= 20;
    reasons.push('overall_view 太短，缺少展开解释');
  }

  if ((result.summary.top_risks?.length ?? 0) < 2) {
    score -= 15;
    reasons.push('top_risks 不足 2 条');
  }

  if ((result.summary.top_opportunities?.length ?? 0) < 2) {
    score -= 15;
    reasons.push('top_opportunities 不足 2 条');
  }

  if ((result.summary.follow_ups?.length ?? 0) < 2) {
    score -= 15;
    reasons.push('follow_ups 不足 2 条');
  }

  if (!result.final_text || result.final_text.trim().length < 180) {
    score -= 25;
    reasons.push('final_text 太短，结论不够稳定');
  }

  score = Math.max(0, Math.min(100, score));
  return {
    ok: score >= 70,
    score,
    reasons,
    summary: reasons.length === 0 ? '质量检查通过' : `质量检查未完全通过：${reasons.join('；')}`,
  };
}

function buildQualityRewritePrompt(params: {
  attempt: number;
  maxAttempts: number;
  minScore: number;
  quality: PortfolioQualityCheckResult;
  previousResult: PortfolioAnalysisResult;
}): string {
  const reasons = params.quality.reasons.length
    ? params.quality.reasons.map((reason, index) => `${index + 1}. ${reason}`).join('\n')
    : '未检测到明确问题';

  return [
    '上一次报告未通过文档质量检查，需要重写一版。',
    `这是第 ${params.attempt}/${params.maxAttempts} 次修复尝试。`,
    `最低分要求：${params.minScore}，上一次得分：${params.quality.score}。`,
    '',
    '请严格按原输出 JSON schema 重写，保持字段和数据结构不变。',
    '- summary.headline 必须更明确且有投资意义',
    '- summary.overall_view 至少要展开原因与影响（避免空洞结论）',
    '- top_risks / top_opportunities / follow_ups 至少各 2 条并且互相不重复',
    '- final_text 要给出更完整的结论和建议（最好 180 字以上）',
    `上一次失败原因：\n${reasons}`,
    '',
    '附加要求：',
    `- 原始 run_id: ${params.previousResult.run_id}`,
    '- 若无法提升到合格，仅能显著提高内容完整度和可读性，不要为了凑字数堆砌空洞句子',
    '- 输出必须是单个合法 JSON，不要附加任何解释文字',
  ].join('\n');
}

function formatPortfolioIndexEntry(params: {
  docUrl?: string;
  docId: string;
  portfolioName: string;
  portfolioId: string;
  runAt: string;
  runId: string;
  trigger: 'manual' | 'manual-job' | 'scheduled';
  status: '成功' | '失败';
  headline: string;
}): string {
  const target = params.docUrl ? `[查看详情](${params.docUrl})` : `文档ID: ${params.docId}`;
  return `- **${params.runAt}**｜${params.portfolioName}（${params.portfolioId}）｜${params.status}\n  - 触发方式: ${params.trigger}\n  - Run: ${params.runId}\n  - 摘要: ${params.headline}\n  - ${target}`;
}

function formatCreateError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

async function createLarkDocument(params: {
  title: string;
  markdown: string;
  identity?: 'bot' | 'user';
  wikiNode?: string;
}): Promise<{ docId: string; docUrl?: string }> {
  const identities: Array<'bot' | 'user'> = [params.identity ?? 'user'];
  if (params.identity === 'bot') {
    identities.push('user');
  }

  let lastError: Error | null = null;

  for (const identity of identities) {
    const args = [
      'docs',
      '+create',
      '--title',
      params.title,
      '--markdown',
      params.markdown,
      '--as',
      identity,
    ];

    if (params.wikiNode) {
      args.push('--wiki-node', params.wikiNode);
    }

    try {
      const output = await runLarkCli(args);
      const parsed = parseLarkResponse<
        | {
            ok?: boolean;
            data?: {
              doc_id?: string;
              doc_url?: string;
              docUrl?: string;
            };
          }
        | {
            doc_id?: string;
            doc_url?: string;
            docUrl?: string;
          }
      >(output);

      const data =
        parsed && 'data' in parsed
          ? parsed.data
          : (parsed as { doc_id?: string; doc_url?: string; docUrl?: string });
      const docId = data?.doc_id;
      if (!docId) {
        throw new Error(`lark-cli create response missing doc_id: ${output}`);
      }

      const docUrl = data?.doc_url ?? data?.docUrl;
      if (identity !== (params.identity ?? 'user')) {
        debugLog(`created portfolio doc ${docId} using fallback identity ${identity}`);
      }
      return { docId, docUrl };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(formatCreateError(err));
      if (identity === 'bot') {
        continue;
      }
      break;
    }
  }

  throw lastError ?? new Error('Failed to create Lark document.');
}

function formatPortfolioDeliveryDocEntry(params: {
  portfolioName: string;
  portfolioId: string;
  trigger: 'manual' | 'manual-job' | 'scheduled';
  result: {
    ok: boolean;
    summary: {
      headline: string;
      overall_view: string;
      top_risks: string[];
      top_opportunities: string[];
      follow_ups: string[];
    };
    final_text: string;
  };
  runId: string;
  runAt: string;
}): string {
  return formatPortfolioDeliveryDocument({
    portfolioName: params.portfolioName,
    portfolioId: params.portfolioId,
    trigger: params.trigger,
    runId: params.runId,
    runAt: params.runAt,
    result: {
      ok: params.result.ok,
      summary: params.result.summary,
      holdings: undefined,
      final_text: params.result.final_text,
    },
  });
}

type PortfolioDetailDoc = {
  docId: string;
  docUrl?: string;
  appended: boolean;
};

function toLarkWebDocUrl(docId: string): string {
  return `https://www.larksuite.com/docx/${docId}`;
}

async function appendPortfolioResultToLarkDoc(params: {
  docId: string;
  portfolioName: string;
  portfolioId: string;
  trigger: 'manual' | 'manual-job' | 'scheduled';
  result: {
    ok: boolean;
    summary: {
      headline: string;
      overall_view: string;
      top_risks: string[];
      top_opportunities: string[];
      follow_ups: string[];
    };
    holdings?: Array<{ ticker: string; status: string; weight?: number }>;
    final_text: string;
  };
  runId: string;
  runAt: string;
  identity?: 'bot' | 'user';
  wikiNode?: string;
}): Promise<PortfolioDetailDoc> {
  const created = await createLarkDocument({
    title: `${params.portfolioName} | ${params.runAt}`,
    identity: params.identity,
    wikiNode: params.wikiNode,
    markdown: formatPortfolioDeliveryDocument({
      portfolioName: params.portfolioName,
      portfolioId: params.portfolioId,
      trigger: params.trigger,
      result: {
        ok: params.result.ok,
        summary: params.result.summary,
        holdings: params.result.holdings,
        final_text: params.result.final_text,
      },
      runId: params.runId,
      runAt: params.runAt,
    }),
  });
  debugLog(`[cron] job create portfolio detail doc ${created.docId} for ${params.portfolioName}`);

  const indexMarkdown = formatPortfolioIndexEntry({
    docUrl: created.docUrl ?? toLarkWebDocUrl(created.docId),
    docId: created.docId,
    portfolioName: params.portfolioName,
    portfolioId: params.portfolioId,
    runAt: params.runAt,
    runId: params.runId,
    trigger: params.trigger,
    status: params.result.ok ? '成功' : '失败',
    headline: params.result.summary.headline,
  });

  const identities: Array<'bot' | 'user'> = [params.identity ?? 'bot'];
  if (params.identity === 'bot') {
    identities.push('user');
  }

  let lastError: Error | null = null;
  let appended = false;
  for (const identity of identities) {
    const args = [
      'docs',
      '+update',
      '--doc',
      params.docId,
      '--as',
      identity,
      '--mode',
      'append',
      '--markdown',
      indexMarkdown,
    ];

    const attemptArgs = [
      ...args,
    ];

    try {
      await runLarkCli(attemptArgs);
      if (identity !== (params.identity ?? 'bot')) {
        debugLog(`[cron] job append fallback succeeded using Lark identity "${identity}"`);
      }
      appended = true;
      return { ...created, appended };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (identity === (params.identity ?? 'bot')) {
        continue;
      }
      break;
    }
  }

  if (lastError) {
    debugLog(`[cron] job append failed after attempts while adding to index doc ${params.docId}: ${lastError.message}`);
    return { ...created, appended: false };
  }

  return { ...created, appended };
}

function getSuppressionState(jobId: string): SuppressionState {
  let state = suppressionStates.get(jobId);
  if (!state) {
    state = { lastMessageText: null, lastMessageAt: null };
    suppressionStates.set(jobId, state);
  }
  return state;
}

type TodoScanCandidate = {
  title: string;
  notes: string;
  status: 'todo';
  time: string;
};

type OpenClawSessionStore = {
  sessionKey?: string;
  sessionFile?: string;
  updatedAt?: number;
};

type OpenClawJsonlMessage = {
  role?: string;
  content?: unknown;
  timestamp?: unknown;
};

type OpenClawJsonlEntry = {
  type?: string;
  timestamp?: string | number;
  id?: string;
  message?: OpenClawJsonlMessage;
};

function getChatHistoryFilePath(): string {
  return dexterPath('messages', 'chat_history.json');
}

function getOpenClawStateDir(override?: string): string {
  const envStateDir =
    override ??
    process.env.OPENCLAW_STATE_DIR ??
    process.env.OPENCLAW_STATE_PATH ??
    process.env.OPENCLAW_DIR ??
    join(homedir(), '.openclaw');
  return envStateDir;
}

function parseMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const chunks = content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        if (!part || typeof part !== 'object') {
          return '';
        }

        const candidate = part as { text?: unknown; content?: unknown; message?: unknown };
        if (typeof candidate.text === 'string') {
          return candidate.text;
        }

        if (typeof candidate.content === 'string') {
          return candidate.content;
        }

        if (typeof candidate.message === 'string') {
          return candidate.message;
        }

        return '';
      })
      .filter(Boolean);

    return chunks.join('\n').trim();
  }

  if (
    content &&
    typeof content === 'object' &&
    'text' in content &&
    typeof (content as { text?: unknown }).text === 'string'
  ) {
    return ((content as { text: string }).text ?? '').trim();
  }

  return '';
}

function extractWrappedReplyBody(text: string): string {
  const repliedMessageMatch = text.match(/Replied message \(untrusted, for context\):\s*```json\s*([\s\S]*?)\s*```/i);
  if (!repliedMessageMatch) {
    return '';
  }

  try {
    const parsed = JSON.parse(repliedMessageMatch[1]) as { body?: unknown };
    return typeof parsed.body === 'string' ? parsed.body.trim() : '';
  } catch {
    return '';
  }
}

function extractWrappedUserMessage(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let extractedLine = '';
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (!line.includes(' : ')) {
      continue;
    }

    const normalized = line.replace(/^\[[^\]]+\]\s*/, '').trim();
    const match = normalized.match(/^[^:]+\s:\s*(.+)$/);
    if (match?.[1]) {
      extractedLine = match[1].trim();
      break;
    }
  }

  const replyBody = extractWrappedReplyBody(text);
  if (replyBody && extractedLine) {
    if (/^\[Replying to:/i.test(extractedLine)) {
      return `${extractedLine}\n\nReply content:\n${replyBody}`.trim();
    }
    return extractedLine;
  }

  if (extractedLine) {
    return extractedLine;
  }

  if (replyBody) {
    return replyBody;
  }

  return text.trim();
}

function normalizeTodoScanMessage(text: string): string {
  if (text.includes('Conversation info (untrusted metadata):') || text.includes('[message_id:')) {
    return extractWrappedUserMessage(text);
  }

  return text.trim();
}

function parseEntryTimestamp(input: unknown, fallbackMs: number): string {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return new Date(input).toISOString();
  }

  if (typeof input === 'string') {
    const ts = Date.parse(input);
    if (Number.isFinite(ts)) {
      return new Date(ts).toISOString();
    }
  }

  return new Date(fallbackMs).toISOString();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildTodoScanMessageFilters(patterns?: string[]): RegExp[] {
  const defaults = [
    'Conversation info (untrusted metadata):',
    'Sender (untrusted metadata):',
    'Replied message (untrusted, for context):',
    'Chat history since last reply (untrusted, for context):',
    '[message_id:',
    'HEARTBEAT_OK',
    'NO_REPLY',
  ];

  return [...defaults, ...(patterns ?? [])]
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map((pattern) => new RegExp(escapeRegExp(pattern), 'i'));
}

function shouldSkipTodoScanMessage(text: string, filters: RegExp[]): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return true;
  }

  return filters.some((filter) => filter.test(normalized));
}

function shouldSkipTodoScanSession(sessionKey: string | undefined, excludedSessionKeys: Set<string>): boolean {
  if (!sessionKey) {
    return false;
  }

  if (excludedSessionKeys.has(sessionKey)) {
    return true;
  }

  if (sessionKey === 'agent:main:main') {
    return true;
  }

  if (sessionKey.startsWith('agent:codex:acp:')) {
    return true;
  }

  if (sessionKey.startsWith('cron:')) {
    return true;
  }

  return false;
}

function isAllowedTodoScanSession(sessionKey: string | undefined, allowedSessionKeys: Set<string>): boolean {
  if (allowedSessionKeys.size === 0) {
    return true;
  }

  if (!sessionKey) {
    return false;
  }

  return allowedSessionKeys.has(sessionKey);
}

function loadOpenClawConversationEntries(params: {
  limit: number;
  openClawStateDir?: string;
  allowSessionKeys?: string[];
  excludeSessionKeys?: string[];
  excludeMessagePatterns?: string[];
}): ConversationEntry[] {
  if (params.limit <= 0) {
    return [];
  }

  const sessionsPath = join(getOpenClawStateDir(params.openClawStateDir), 'agents');
  if (!existsSync(sessionsPath)) {
    return [];
  }

  const allowedSessionKeys = new Set(params.allowSessionKeys ?? []);
  const excludedSessionKeys = new Set(params.excludeSessionKeys ?? []);
  const messageFilters = buildTodoScanMessageFilters(params.excludeMessagePatterns);

  let agentDirs: string[];
  try {
    agentDirs = readdirSync(sessionsPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(sessionsPath, entry.name));
  } catch {
    return [];
  }

  if (agentDirs.length === 0) {
    return [];
  }

  const rawEntries: { entry: ConversationEntry; timestampMs: number; order: number }[] = [];
  let order = 0;

  for (const agentDir of agentDirs) {
    const storePath = join(agentDir, 'sessions', 'sessions.json');
    if (!existsSync(storePath)) {
      continue;
    }

    let storePayload: Record<string, OpenClawSessionStore>;
    try {
      storePayload = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, OpenClawSessionStore>;
    } catch {
      continue;
    }

    const sessionMeta = Object.values(storePayload)
      .filter((session) => typeof session?.sessionFile === 'string')
      .filter((session) => isAllowedTodoScanSession(session.sessionKey, allowedSessionKeys))
      .filter((session) => !shouldSkipTodoScanSession(session.sessionKey, excludedSessionKeys))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    for (const meta of sessionMeta) {
      const sessionFile = meta.sessionFile;
      if (!sessionFile || !existsSync(sessionFile)) {
        continue;
      }

      let sessionLog: string;
      try {
        sessionLog = readFileSync(sessionFile, 'utf8');
      } catch {
        continue;
      }

      let pendingUser: ConversationEntry | null = null;
      const fallbackMs = Date.parse(parseEntryTimestamp(meta.updatedAt, Date.now()));
      const fallbackTimestamp = Number.isFinite(fallbackMs) ? fallbackMs : Date.now();

      for (const line of sessionLog.split('\n')) {
        if (!line.trim()) {
          continue;
        }

        let event: OpenClawJsonlEntry;
        try {
          event = JSON.parse(line) as OpenClawJsonlEntry;
        } catch {
          continue;
        }

        if (event.type !== 'message' || !event.message) {
          continue;
        }

        const role = event.message.role;
        if (role !== 'user' && role !== 'assistant') {
          continue;
        }

        const rawText = parseMessageText(event.message.content);
        if (!rawText) {
          continue;
        }

        const text = normalizeTodoScanMessage(rawText);
        if (!text) {
          continue;
        }

        if (shouldSkipTodoScanMessage(text, messageFilters)) {
          continue;
        }

        const ts = parseEntryTimestamp(event.timestamp ?? event.message.timestamp, fallbackTimestamp);

        if (role === 'user') {
          pendingUser = {
            id: event.id ?? `openclaw:${order}`,
            timestamp: ts,
            userMessage: text,
            agentResponse: null,
          };
          continue;
        }

        if (role === 'assistant' && pendingUser) {
          rawEntries.push({
            entry: {
              ...pendingUser,
              agentResponse: text,
            },
            timestampMs: Date.parse(pendingUser.timestamp),
            order,
          });
          order += 1;
          pendingUser = null;
        }
      }
    }
  }

  const ordered = rawEntries
    .sort((a, b) => {
      if (b.timestampMs !== a.timestampMs) {
        return b.timestampMs - a.timestampMs;
      }
      return b.order - a.order;
    })
    .slice(0, params.limit)
    .map((item) => item.entry);

  return ordered;
}

function loadRecentConversationEntries(params: {
  limit: number;
  useOpenClawSessions?: boolean;
  openClawStateDir?: string;
  allowSessionKeys?: string[];
  excludeSessionKeys?: string[];
  excludeMessagePatterns?: string[];
}): ConversationEntry[] {
  const useOpenClawSessions = params.useOpenClawSessions ?? true;

  if (useOpenClawSessions) {
    const openClawEntries = loadOpenClawConversationEntries({
      limit: params.limit,
      openClawStateDir: params.openClawStateDir,
      allowSessionKeys: params.allowSessionKeys,
      excludeSessionKeys: params.excludeSessionKeys,
      excludeMessagePatterns: params.excludeMessagePatterns,
    });
    if (openClawEntries.length > 0) {
      return openClawEntries;
    }

    debugLog('[todo_scan] no OpenClaw session history found, falling back to local chat_history.json');
  }

  const filePath = getChatHistoryFilePath();
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { messages?: ConversationEntry[] };
    return (parsed.messages ?? []).slice(0, params.limit);
  } catch {
    return [];
  }
}

function buildTodoScanPrompt(entries: ConversationEntry[]): string {
  const transcript = entries
    .map((entry, index) => {
      const agentResponse = entry.agentResponse ? `Assistant: ${entry.agentResponse}` : 'Assistant: (no response)';
      return [
        `Entry ${index + 1}`,
        `Timestamp: ${entry.timestamp}`,
        `User: ${entry.userMessage}`,
        agentResponse,
      ].join('\n');
    })
    .join('\n\n');

  return [
    'You are extracting todos from recent conversations.',
    'Return JSON only in this exact shape:',
    '{"todos":[{"title":"...","notes":"...","status":"todo","time":""}]}',
    '',
    'Rules:',
    '- Only include explicit, actionable asks from the user.',
    '- Skip things already clearly done.',
    '- Skip vague wishes with no action.',
    '- status must always be "todo".',
    '- time should be empty string unless the user explicitly mentioned a time.',
    '- Deduplicate very similar asks into one todo.',
    '- Keep titles short and concrete.',
    '',
    transcript || 'No recent entries.',
  ].join('\n');
}

function normalizeTodoTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function fetchExistingTodos(params: { supabaseUrl: string; serviceKey: string }): Promise<Array<{ title: string; status: string }>> {
  const response = await fetch(`${params.supabaseUrl}/rest/v1/todos?select=title,status`, {
    headers: {
      apikey: params.serviceKey,
      Authorization: `Bearer ${params.serviceKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed fetching existing todos: ${await response.text()}`);
  }

  return (await response.json()) as Array<{ title: string; status: string }>;
}

async function insertTodos(params: { supabaseUrl: string; serviceKey: string; todos: TodoScanCandidate[] }): Promise<number> {
  if (params.todos.length === 0) {
    return 0;
  }

  const response = await fetch(`${params.supabaseUrl}/rest/v1/todos`, {
    method: 'POST',
    headers: {
      apikey: params.serviceKey,
      Authorization: `Bearer ${params.serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(params.todos),
  });

  if (!response.ok) {
    throw new Error(`Failed inserting todos: ${await response.text()}`);
  }

  const inserted = await response.json();
  return Array.isArray(inserted) ? inserted.length : 0;
}

function extractTodosFromAgentAnswer(answer: string): TodoScanCandidate[] {
  const match = answer.match(/\{[\s\S]*\}/);
  if (!match) {
    return [];
  }

  try {
    const parsed = JSON.parse(match[0]) as { todos?: TodoScanCandidate[] };
    return (parsed.todos ?? [])
      .filter((todo) => todo && typeof todo.title === 'string' && todo.title.trim().length > 0)
      .map((todo) => ({
        title: todo.title.trim(),
        notes: typeof todo.notes === 'string' ? todo.notes.trim() : '',
        status: 'todo',
        time: typeof todo.time === 'string' ? todo.time.trim() : '',
      }));
  } catch {
    return [];
  }
}

/**
 * Check if the current time is within configured active hours and days.
 */
function isWithinActiveHours(activeHours?: ActiveHours): boolean {
  if (!activeHours) return true;

  const tz = activeHours.timezone ?? 'America/New_York';
  const now = new Date();

  const allowedDays = activeHours.daysOfWeek ?? [1, 2, 3, 4, 5];
  const dayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
  const dayStr = dayFormatter.format(now);
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const currentDay = dayMap[dayStr] ?? now.getDay();
  if (!allowedDays.includes(currentDay)) return false;

  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const currentTime = timeFormatter.format(now);
  return currentTime >= activeHours.start && currentTime <= activeHours.end;
}

function errorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[Math.max(0, idx)];
}

/**
 * Find the most recently updated session with a delivery target.
 * Same pattern as heartbeat runner.
 */
function findTargetSession(): SessionEntry | null {
  const storePath = resolveSessionStorePath('default');
  const store = loadSessionStore(storePath);
  const entries = Object.values(store).filter((e) => e.lastTo);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return entries[0];
}

/**
 * Execute a single cron job: run isolated agent, evaluate suppression,
 * deliver via WhatsApp, apply fulfillment mode, update state.
 */
export async function executeCronJob(
  job: CronJob,
  store: CronStore,
  _params: { configPath?: string },
): Promise<void> {
  const startedAt = Date.now();

  // 0. Check active hours
  if (!isWithinActiveHours(job.activeHours)) {
    debugLog(`[cron] job ${job.id}: outside active hours, skipping`);
    scheduleNextRun(job, store);
    return;
  }

  debugLog(`[cron] executing job "${job.name}" (${job.id})`);

  if (job.payload.kind === 'todo_scan') {
    try {
      const supabaseUrl = job.payload.supabaseUrl ?? process.env.TODO_SCAN_SUPABASE_URL;
      const supabaseServiceKey = job.payload.supabaseServiceKey ?? process.env.TODO_SCAN_SUPABASE_SERVICE_KEY;
      if (!supabaseUrl || !supabaseServiceKey) {
        throw new Error('todo_scan requires supabaseUrl and supabaseServiceKey.');
      }

      const scanLimit = job.payload.sessionScanLimit ?? 25;
      const entries = loadRecentConversationEntries({
        limit: scanLimit,
        useOpenClawSessions: job.payload.todoScanUseOpenClawSessions,
        openClawStateDir: job.payload.todoScanOpenClawStateDir,
        allowSessionKeys: job.payload.todoScanAllowSessionKeys,
        excludeSessionKeys: job.payload.todoScanExcludeSessionKeys,
        excludeMessagePatterns: job.payload.todoScanExcludeMessagePatterns,
      });
      if (entries.length === 0) {
        debugLog(`[cron] job ${job.id}: no recent conversation entries for todo_scan`);
        scheduleNextRun(job, store);
        return;
      }

      const model = job.payload.model ?? (getSetting('modelId', 'gpt-5.4') as string);
      const modelProvider = job.payload.modelProvider ?? (getSetting('provider', 'openai') as string);
      const answer = await runAgentForMessage({
        sessionKey: `cron:${job.id}:todo_scan`,
        query: buildTodoScanPrompt(entries),
        model,
        modelProvider,
        maxIterations: 4,
        isolatedSession: true,
        channel: 'whatsapp',
      });

      const candidates = extractTodosFromAgentAnswer(answer);
      const existingTodos = await fetchExistingTodos({ supabaseUrl, serviceKey: supabaseServiceKey });
      const existingOpenTitles = new Set(
        existingTodos
          .filter((todo) => todo.status !== 'done')
          .map((todo) => normalizeTodoTitle(todo.title)),
      );

      const dedupedCandidates = candidates.filter((todo, index, arr) => {
        const normalized = normalizeTodoTitle(todo.title);
        if (!normalized || existingOpenTitles.has(normalized)) {
          return false;
        }
        return arr.findIndex((item) => normalizeTodoTitle(item.title) === normalized) === index;
      });

      const insertedCount = await insertTodos({
        supabaseUrl,
        serviceKey: supabaseServiceKey,
        todos: dedupedCandidates,
      });

      debugLog(`[cron] job ${job.id}: todo_scan inserted ${insertedCount} todos from ${entries.length} entries`);

      job.state.lastRunAtMs = startedAt;
      job.state.lastDurationMs = Date.now() - startedAt;
      job.state.consecutiveErrors = 0;
      job.state.lastRunStatus = 'ok';
      job.state.lastError = undefined;
      scheduleNextRun(job, store);
      return;
    } catch (err) {
      handleJobError(job, store, err, startedAt);
      return;
    }
  }

  if (job.payload.kind === 'portfolio' && job.payload.portfolioId) {
    try {
      const config = loadPortfolioConfig();
      const portfolio = getPortfolioById(config, job.payload.portfolioId);
      if (!portfolio) {
        throw new Error(`Portfolio "${job.payload.portfolioId}" not found.`);
      }

      const modelConfig = resolveEffectiveModel({
        cliModel: job.payload.model,
        cliProvider: job.payload.modelProvider,
        portfolio,
        sourceOverride: 'cron',
      });

      let result = await runPortfolioAnalysis({
        portfolio,
        modelConfig,
        trigger: 'scheduled',
      });

      if (!result.ok) {
        throw new Error(
          result.summary.headline || result.diagnostics.errors.join('; ') || 'Portfolio analysis returned unsuccessful result.',
        );
      }

      const qualityEnabled = portfolio.qualityCheck?.enabled ?? true;
      const minScore = portfolio.qualityCheck?.minScore ?? 70;
      const maxRetries = portfolio.qualityCheck?.maxRetries ?? 1;

      let qualityCheck = runPortfolioQualityCheck(result);
      let retryCount = 0;
      while (qualityEnabled && qualityCheck.score < minScore && retryCount < maxRetries) {
        retryCount += 1;
        debugLog(`[cron] job ${job.id}: quality check failed (${qualityCheck.score}/${minScore}), retrying analysis ${retryCount}/${maxRetries}`);

        result = await runPortfolioAnalysis({
          portfolio,
          modelConfig,
          trigger: 'scheduled',
          extraInstructions: buildQualityRewritePrompt({
            attempt: retryCount,
            maxAttempts: maxRetries,
            minScore,
            quality: qualityCheck,
            previousResult: result,
          }),
        });

        if (!result.ok) {
          throw new Error(
            result.summary.headline || result.diagnostics.errors.join('; ') || 'Portfolio analysis returned unsuccessful result.',
          );
        }

        qualityCheck = runPortfolioQualityCheck(result);
      }

      if (qualityEnabled && qualityCheck.score < minScore) {
        throw new Error(
          `Portfolio analysis quality check failed (${qualityCheck.score}/${minScore}): ${qualityCheck.summary}`,
        );
      }

      const delivery = job.payload.delivery;
      if (delivery?.kind === 'lark') {
        if (!delivery.larkChatId) {
          throw new Error('Portfolio delivery is configured for Lark but larkChatId is missing.');
        }

        const runAt = new Date(startedAt).toLocaleString('zh-CN', {
          timeZone: 'Asia/Hong_Kong',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });

        let detailDoc: PortfolioDetailDoc | undefined;
        if (delivery.larkDocId) {
          try {
            detailDoc = await appendPortfolioResultToLarkDoc({
              docId: delivery.larkDocId,
              portfolioName: portfolio.name,
              portfolioId: portfolio.id,
              trigger: 'scheduled',
              result,
              runId: result.run_id,
              runAt,
              identity: delivery.larkIdentity,
              wikiNode: delivery.larkWikiNode,
            });
            debugLog(`[cron] job ${job.id}: appended to Lark doc ${delivery.larkDocId} (appended=${detailDoc.appended})`);
          } catch (appendErr) {
            const appendError = appendErr instanceof Error ? appendErr.message : String(appendErr);
            debugLog(`[cron] job ${job.id}: failed to append Lark doc ${delivery.larkDocId}: ${appendError}`);
          }
        }

        const text = formatPortfolioDeliveryMessage({
          portfolioName: portfolio.name,
          portfolioId: portfolio.id,
          trigger: 'scheduled',
          result,
          runId: result.run_id,
          detailDocUrl: detailDoc?.docUrl ?? (detailDoc?.docId ? toLarkWebDocUrl(detailDoc.docId) : undefined),
        });

        await sendPortfolioMessageToLark({
          chatId: delivery.larkChatId,
          text,
          identity: delivery.larkIdentity,
        });
        debugLog(`[cron] job ${job.id}: delivered to Lark chat ${delivery.larkChatId}`);
      }

      job.state.lastRunAtMs = startedAt;
      job.state.lastDurationMs = Date.now() - startedAt;
      job.state.consecutiveErrors = 0;
      job.state.lastRunStatus = 'ok';
      job.state.lastError = undefined;

      if (job.fulfillment === 'once') {
        job.enabled = false;
        job.state.nextRunAtMs = undefined;
        job.updatedAtMs = Date.now();
        saveCronStore(store);
        return;
      }

      scheduleNextRun(job, store);
      return;
    } catch (err) {
      handleJobError(job, store, err, startedAt);
      return;
    }
  }

  // 1. Find WhatsApp delivery target
  const session = findTargetSession();
  if (!session?.lastTo || !session?.lastAccountId) {
    debugLog(`[cron] job ${job.id}: no delivery target, skipping`);
    scheduleNextRun(job, store);
    return;
  }

  // 2. Verify outbound allowed
  try {
    assertOutboundAllowed({ to: session.lastTo, accountId: session.lastAccountId });
  } catch {
    debugLog(`[cron] job ${job.id}: outbound blocked, skipping`);
    scheduleNextRun(job, store);
    return;
  }

  // 3. Resolve model
  const model = job.payload.model ?? (getSetting('modelId', 'gpt-5.4') as string);
  const modelProvider = job.payload.modelProvider ?? (getSetting('provider', 'openai') as string);

  // 4. Build query
  const baseMessage = job.payload.message ?? '';
  let query = `[CRON JOB: ${job.name}]\n\n${baseMessage}`;
  if (job.fulfillment === 'ask') {
    query += '\n\nIf you find something noteworthy, also ask the user if they want to continue monitoring this.';
  }
  query += `\n\n## Instructions\n- If nothing noteworthy, respond with exactly: ${HEARTBEAT_OK_TOKEN}\n- Do NOT send a message just to say "everything is fine"\n- Keep alerts brief and focused — lead with the key finding`;

  // 5. Run agent
  let answer: string;
  try {
    answer = await runAgentForMessage({
      sessionKey: `cron:${job.id}`,
      query,
      model,
      modelProvider,
      maxIterations: 6,
      isolatedSession: true,
      channel: 'whatsapp',
    });
  } catch (err) {
    handleJobError(job, store, err, startedAt);
    return;
  }

  const durationMs = Date.now() - startedAt;

  // 6. Evaluate suppression
  const suppState = getSuppressionState(job.id);
  const suppResult = evaluateSuppression(answer, suppState);

  // 7. Update job state
  job.state.lastRunAtMs = startedAt;
  job.state.lastDurationMs = durationMs;
  job.state.consecutiveErrors = 0;

  if (suppResult.shouldSuppress) {
    job.state.lastRunStatus = 'suppressed';
    debugLog(`[cron] job ${job.id}: suppressed (${suppResult.reason})`);
  } else {
    job.state.lastRunStatus = 'ok';

    // Deliver via WhatsApp
    const cleaned = cleanMarkdownForWhatsApp(suppResult.cleanedText);
    await sendMessageWhatsApp({
      to: session.lastTo,
      body: cleaned,
      accountId: session.lastAccountId,
    });
    debugLog(`[cron] job ${job.id}: delivered to ${session.lastTo}`);

    // Update suppression state for duplicate detection
    suppState.lastMessageText = suppResult.cleanedText;
    suppState.lastMessageAt = Date.now();

    // Apply fulfillment mode
    if (job.fulfillment === 'once') {
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
      debugLog(`[cron] job ${job.id}: auto-disabled (fulfillment=once)`);
      job.updatedAtMs = Date.now();
      saveCronStore(store);
      return;
    }
  }

  scheduleNextRun(job, store);
}

function scheduleNextRun(job: CronJob, store: CronStore): void {
  const now = Date.now();

  try {
    const nextRun = computeNextRunAtMs(job.schedule, now);
    if (nextRun === undefined) {
      // One-shot expired or invalid schedule
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
    } else {
      job.state.nextRunAtMs = nextRun;
    }
    job.state.scheduleErrorCount = 0;
  } catch {
    job.state.scheduleErrorCount += 1;
    if (job.state.scheduleErrorCount >= SCHEDULE_ERROR_DISABLE_THRESHOLD) {
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
      debugLog(`[cron] job ${job.id}: disabled after ${SCHEDULE_ERROR_DISABLE_THRESHOLD} schedule errors`);
    }
  }

  job.updatedAtMs = Date.now();
  saveCronStore(store);
}

function handleJobError(job: CronJob, store: CronStore, err: unknown, startedAt: number): void {
  const errorMsg = err instanceof Error ? err.message : String(err);
  job.state.lastRunAtMs = startedAt;
  job.state.lastDurationMs = Date.now() - startedAt;
  job.state.lastRunStatus = 'error';
  job.state.lastError = errorMsg;
  job.state.consecutiveErrors += 1;

  debugLog(`[cron] job ${job.id}: error #${job.state.consecutiveErrors}: ${errorMsg}`);

  const now = Date.now();

  if (job.schedule.kind === 'at') {
    // One-shot: retry up to MAX_AT_RETRIES, then disable
    if (job.state.consecutiveErrors >= MAX_AT_RETRIES) {
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
      debugLog(`[cron] job ${job.id}: disabled after ${MAX_AT_RETRIES} retries (at job)`);
    } else {
      job.state.nextRunAtMs = now + errorBackoffMs(job.state.consecutiveErrors);
    }
  } else {
    // Recurring: apply exponential backoff
    const normalNext = computeNextRunAtMs(job.schedule, now);
    const backoff = now + errorBackoffMs(job.state.consecutiveErrors);
    job.state.nextRunAtMs = normalNext ? Math.max(normalNext, backoff) : backoff;
  }

  job.updatedAtMs = Date.now();
  saveCronStore(store);
}
