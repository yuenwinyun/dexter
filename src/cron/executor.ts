import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
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
    `### 核心持仓\n${holdings}\n\n` +
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
