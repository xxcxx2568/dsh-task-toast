/**
 * dsh-task-toast —— 浏览器侧插件。
 *
 * 监听所有已打开会话的 `turn/end` 事件（同时用会话列表的 running 位兜底），
 * 在 `shell.overlay` 这个根作用域槽位里渲染右下角通知：
 *
 *   任务已完成
 *   「会话标题」对话已就绪，可以回来继续查看。
 *   最终回复的一小段摘要
 *   14:32 · 用时 1 分 23 秒        [查看对话 →]
 *
 * 通知不会进入模型请求，也不写入会话记录；关闭页面即消失。
 */

window.__ModuleLoader__.load({
	id: "dsh-task-toast",
	factory: (require) => {
		const React = require("react");
		const {
			createElement: h,
			useCallback,
			useEffect,
			useMemo,
			useRef,
			useState,
			useSyncExternalStore,
		} = React;

		/** 同时最多保留几条通知；再多就挤掉最旧的。 */
		const MAX_TOASTS = 3;
		/** 列表 running 位比 turn/end 早到时，等一小会儿再兜底，避免和事件重复。 */
		const FALLBACK_DELAY_MS = 900;
		/** 兜底通知已经发出后，短时间内迟到的 turn/end 不再补一张重复卡。 */
		const FALLBACK_QUIET_MS = 5000;
		/** 兜底扫描周期：绑定可能在不触发列表更新的情况下出现。 */
		const SCAN_MS = 2500;
		/** 后台会话结束后，保留一小段时间以接住迟到的 turn/end，再释放引用。 */
		const RELEASE_GRACE_MS = 10000;
		const STYLE_ID = "dsh-task-toast/style";
		const API_BASE = "/dsh-task-toast/api";

		const STORAGE = {
			enabled: "dsh-task-toast.enabled",
			duration: "dsh-task-toast.duration",
			prices: "dsh-task-toast.prices",
		};

		/**
		 * DeepSeek 官方价（人民币 / 百万 tokens），2026-11 抓取自
		 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
		 *
		 * 高峰：北京时间周一至周五 9:00–12:00、14:00–18:00；其余为空闲价。
		 * 法定节假日没有单独建模，会按星期几近似——需要精确账单请以官方为准，
		 * 或通过 localStorage 覆盖价格。
		 */
		const DEEPSEEK_PRICING = {
			"deepseek-flash": {
				currency: "CNY",
				peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
				idle: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
			},
			"deepseek-v4-flash": {
				currency: "CNY",
				peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
				idle: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
			},
			"deepseek-v4-pro": {
				currency: "CNY",
				peak: { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 },
				idle: { input: 4.5, cacheRead: 0.15, cacheWrite: 0, output: 13.5 },
			},
		};

		const CSS = [
			".dtt-stack{position:absolute;right:24px;bottom:24px;z-index:5;display:flex;flex-direction:column;gap:10px;align-items:flex-end;width:min(384px,calc(100vw - 48px));pointer-events:none}",
			".dtt-card{position:relative;overflow:hidden;pointer-events:auto;box-sizing:border-box;width:100%;display:flex;gap:11px;padding:13px 14px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 94%,transparent);backdrop-filter:blur(14px) saturate(140%);box-shadow:0 18px 48px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08);color:var(--dsw-alias-label-primary);animation:dtt-in .24s cubic-bezier(.22,.9,.3,1)}",
			".dtt-card:hover{border-color:var(--dsw-alias-border-l3);box-shadow:0 20px 54px rgba(0,0,0,.22),0 2px 8px rgba(0,0,0,.1)}",
			'.dtt-card::before{content:"";position:absolute;left:0;top:14px;bottom:14px;width:3px;border-radius:0 3px 3px 0;background:var(--dtt-accent)}',
			".dtt-card.dtt-closing{animation:dtt-out .16s ease forwards;pointer-events:none}",
			".dtt-success{--dtt-accent:#22a06b;--dtt-accent-soft:rgba(34,160,107,.13)}",
			".dtt-error{--dtt-accent:#e5484d;--dtt-accent-soft:rgba(229,72,77,.13)}",
			".dtt-warn{--dtt-accent:#d99b00;--dtt-accent-soft:rgba(217,155,0,.14)}",
			".dtt-muted{--dtt-accent:#8a8f98;--dtt-accent-soft:rgba(138,143,152,.14)}",
			".dtt-icon{flex:none;width:28px;height:28px;margin-top:1px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:var(--dtt-accent-soft);color:var(--dtt-accent)}",
			".dtt-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}",
			".dtt-head{display:flex;align-items:baseline;gap:8px;min-width:0}",
			".dtt-title{font-size:13px;font-weight:600;line-height:18px;letter-spacing:.01em;color:var(--dsw-alias-label-primary);white-space:nowrap}",
			".dtt-time{margin-left:auto;flex:none;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
			".dtt-close{flex:none;width:20px;height:20px;margin:-2px -3px 0 0;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:15px;line-height:20px;text-align:center;cursor:pointer;opacity:.75}",
			".dtt-close:hover{opacity:1;background:rgba(127,127,127,.14);color:var(--dsw-alias-label-primary)}",
			".dtt-body{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
			".dtt-session{color:var(--dsw-alias-label-primary);font-weight:500}",
			".dtt-snippet{margin-top:3px;padding:7px 9px;border-radius:8px;background:rgba(127,127,127,.075);font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden;overflow-wrap:anywhere}",
			".dtt-stats{display:flex;flex-direction:column;gap:3px;margin-top:5px;padding:7px 9px;border-radius:8px;background:rgba(127,127,127,.06)}",
			".dtt-stat-row{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:11px;line-height:16px}",
			".dtt-stat-row+.dtt-stat-row{padding-top:3px;border-top:1px solid rgba(127,127,127,.09)}",
			".dtt-stat-label{flex:none;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
			".dtt-stat-tokens{margin-left:auto;min-width:0;color:var(--dsw-alias-label-secondary);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dtt-stat-cost{flex:none;min-width:58px;color:var(--dsw-alias-label-primary);text-align:right;font-variant-numeric:tabular-nums;font-weight:500;white-space:nowrap}",
			".dtt-stat-cost.unknown{color:var(--dsw-alias-label-tertiary);font-weight:400}",
			".dtt-foot{display:flex;align-items:center;gap:10px;margin-top:5px}",
			".dtt-open{display:inline-flex;align-items:center;gap:4px;border:0;border-radius:7px;padding:3px 7px;margin-left:-7px;background:transparent;color:var(--dsw-alias-brand-primary,#4e7cff);font:inherit;font-size:11.5px;line-height:18px;font-weight:500;cursor:pointer}",
			".dtt-open:hover{background:rgba(78,124,255,.1)}",
			".dtt-arrow{font-size:12px;transition:transform .15s ease}",
			".dtt-open:hover .dtt-arrow{transform:translateX(2px)}",
			".dtt-meta{margin-left:auto;flex:none;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
			".dtt-progress{position:absolute;left:0;right:0;bottom:0;height:2px;transform-origin:left center;background:var(--dtt-accent);opacity:.55;animation-name:dtt-drain;animation-timing-function:linear;animation-fill-mode:forwards}",
			".dtt-card:hover .dtt-progress,.dtt-card:focus-within .dtt-progress{opacity:.75}",
			"@keyframes dtt-in{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}",
			"@keyframes dtt-out{to{opacity:0;transform:translateY(6px) scale(.99)}}",
			"@keyframes dtt-drain{from{transform:scaleX(1)}to{transform:scaleX(0)}}",
			"@media (prefers-reduced-motion:reduce){.dtt-card{animation:none}.dtt-card.dtt-closing{animation:none;opacity:0}.dtt-arrow{transition:none}}",
			"@media (max-width:560px){.dtt-stack{right:12px;bottom:12px;width:calc(100vw - 24px)}}",
		].join("");

		function installStyle() {
			if (typeof document === "undefined") return;
			const existing = document.getElementById(STYLE_ID);
			// 热更新会保留旧的 <style> 标签；这里必须覆盖 textContent，
			// 否则新加的 .dtt-stats 规则永远不会进入页面。
			if (existing) {
				if (existing.textContent !== CSS) existing.textContent = CSS;
				return;
			}
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		function useStyleOnce() {
			useEffect(() => {
				installStyle();
			}, []);
		}

		/**
		 * 卡片是浮层，不是滚动容器；鼠标停在卡片上时浏览器会把滚轮事件给卡片，
		 * 底下的对话就滚不动。这里把增量转给指针下方真正的可滚动容器。
		 */
		function forwardWheel(card, event) {
			if (!card || !event || event.ctrlKey || (!event.deltaY && !event.deltaX))
				return false;
			if (
				typeof document === "undefined" ||
				typeof document.elementsFromPoint !== "function"
			)
				return false;
			let elements;
			try {
				elements = document.elementsFromPoint(event.clientX, event.clientY);
			} catch {
				return false;
			}
			for (const element of elements) {
				if (card.contains(element)) continue;
				let node = element;
				while (
					node &&
					node !== document.body &&
					node !== document.documentElement
				) {
					let style;
					try {
						style = getComputedStyle(node);
					} catch {
						style = null;
					}
					if (
						style &&
						(style.overflowY === "auto" || style.overflowY === "scroll") &&
						node.scrollHeight > node.clientHeight + 1
					) {
						const unit =
							event.deltaMode === 1
								? 16
								: event.deltaMode === 2
									? node.clientHeight
									: 1;
						node.scrollTop += event.deltaY * unit;
						if (event.deltaX) node.scrollLeft += event.deltaX * unit;
						if (typeof event.preventDefault === "function")
							event.preventDefault();
						return true;
					}
					node = node.parentElement;
				}
			}
			return false;
		}

		function readLanguage() {
			try {
				const declared = document.documentElement?.getAttribute("lang");
				if (declared) return declared.toLowerCase();
			} catch {}
			try {
				return String(navigator?.language || "zh-CN").toLowerCase();
			} catch {
				return "zh-cn";
			}
		}

		const ZH = {
			region: "任务通知",
			close: "关闭通知",
			open: "查看对话",
			untitled: "未命名对话",
			duration: (text) => `用时 ${text}`,
			turnLabel: "本次",
			totalLabel: "对话累计",
			tokens: "tokens",
			approx: "≈",
			costUnavailable: "—",
			pricingUnknown:
				"该模型未配置价格，仅显示 token。可在 localStorage 的 dsh-task-toast.prices 中补充。",
			costHint:
				"按模型单价估算，非账单；DeepSeek 自动区分峰谷，不含搜索/抓取费用，节假日未单独建模。",
			observedOnly: "未读取到完整历史，累计从插件启动后开始。",
			reasons: {
				completed: {
					title: "任务已完成",
					body: "对话已就绪，可以回来继续查看。",
					tone: "success",
					icon: "check",
				},
				error: {
					title: "任务执行失败",
					body: "执行过程中出现错误，打开对话查看详情。",
					tone: "error",
					icon: "alert",
				},
				aborted: {
					title: "任务已停止",
					body: "这次执行被停止，对话内容已保留。",
					tone: "muted",
					icon: "stop",
				},
				interrupted: {
					title: "任务已中断",
					body: "DSH 在执行过程中退出，本轮已停止。",
					tone: "warn",
					icon: "pause",
				},
				"max-tokens": {
					title: "输出达到上限",
					body: "本轮输出达到上限就结束了，对话已保留。",
					tone: "warn",
					icon: "alert",
				},
				unknown: {
					title: "任务已结束",
					body: "对话已就绪。",
					tone: "success",
					icon: "check",
				},
			},
		};

		const EN = {
			region: "Task notifications",
			close: "Dismiss notification",
			open: "Open conversation",
			untitled: "Untitled conversation",
			duration: (text) => `${text} elapsed`,
			turnLabel: "This task",
			totalLabel: "Conversation",
			tokens: "tokens",
			approx: "≈",
			costUnavailable: "—",
			pricingUnknown:
				"No price is configured for this model; tokens are shown without cost.",
			costHint:
				"Estimated from model prices, not a bill; DeepSeek peak/idle is applied automatically, and search/fetch fees are excluded.",
			observedOnly:
				"Full history is unavailable; the total starts when the plugin loaded.",
			reasons: {
				completed: {
					title: "Task complete",
					body: "The conversation is ready — jump back in.",
					tone: "success",
					icon: "check",
				},
				error: {
					title: "Task failed",
					body: "Something went wrong. Open the conversation for details.",
					tone: "error",
					icon: "alert",
				},
				aborted: {
					title: "Task stopped",
					body: "The run was stopped. The conversation is preserved.",
					tone: "muted",
					icon: "stop",
				},
				interrupted: {
					title: "Task interrupted",
					body: "DSH exited mid-run, so this turn was stopped.",
					tone: "warn",
					icon: "pause",
				},
				"max-tokens": {
					title: "Output limit reached",
					body: "The turn ended at the output limit. The conversation is preserved.",
					tone: "warn",
					icon: "alert",
				},
				unknown: {
					title: "Task finished",
					body: "The conversation is ready.",
					tone: "success",
					icon: "check",
				},
			},
		};

		function makeCopy() {
			return readLanguage().startsWith("zh") ? ZH : EN;
		}

		function createStore() {
			let items = [];
			const listeners = new Set();
			const emit = () => {
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch {}
				}
			};
			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				getSnapshot() {
					return items;
				},
				push(item) {
					const next = [...items, item];
					items =
						next.length > MAX_TOASTS
							? next.slice(next.length - MAX_TOASTS)
							: next;
					emit();
				},
				remove(id) {
					const next = items.filter((item) => item.id !== id);
					if (next.length === items.length) return;
					items = next;
					emit();
				},
				clear() {
					if (items.length === 0) return;
					items = [];
					emit();
				},
			};
		}

		function readSettings() {
			let enabled = true;
			let duration = 5000;
			try {
				if (localStorage.getItem(STORAGE.enabled) === "0") enabled = false;
				const value = Number(localStorage.getItem(STORAGE.duration));
				if (Number.isFinite(value) && value >= 2000)
					duration = Math.min(value, 30000);
			} catch {}
			return { enabled, duration };
		}

		function formatDuration(ms, copy) {
			if (!Number.isFinite(ms) || ms < 1000) return "";
			const total = Math.round(ms / 1000);
			if (total < 60) return copy === ZH ? `${total} 秒` : `${total}s`;
			const minutes = Math.floor(total / 60);
			const seconds = total % 60;
			if (minutes < 60) {
				if (copy === ZH)
					return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
				return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
			}
			const hours = Math.floor(minutes / 60);
			const rest = minutes % 60;
			return copy === ZH ? `${hours} 小时 ${rest} 分` : `${hours}h ${rest}m`;
		}

		function assistantText(event) {
			const content = event?.data?.message?.content;
			if (typeof content === "string") return content.trim();
			if (!Array.isArray(content)) return "";
			const parts = [];
			for (const block of content) {
				if (block && block.type === "text" && typeof block.text === "string")
					parts.push(block.text);
			}
			return parts.join("\n").trim();
		}

		function previewText(text) {
			const cleaned = String(text)
				.replace(/```[\s\S]*?```/g, " ")
				.replace(/~~~[\s\S]*?~~~/g, " ")
				.replace(/`([^`]+)`/g, "$1")
				.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
				.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
				.replace(/^#{1,6}\s+/gm, "")
				.replace(/[*_~>#]+/g, "")
				.replace(/\s+/g, " ")
				.trim();
			if (!cleaned) return "";
			return cleaned.length > 180
				? `${cleaned.slice(0, 180).trimEnd()}…`
				: cleaned;
		}

		/** 置顶窗口里展示的完整回复：保留换行，去掉 Markdown 记号。 */
		function detailText(text) {
			const cleaned = String(text || "")
				.replace(/```[a-zA-Z0-9_-]*\s*/g, "")
				.replace(/~~~[a-zA-Z0-9_-]*\s*/g, "")
				.replace(/^#{1,6}\s+/gm, "")
				.replace(/\*\*([^*]+)\*\*/g, "$1")
				.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
				.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
				.replace(/`([^`]+)`/g, "$1")
				.replace(/\r\n/g, "\n")
				.trim();
			if (!cleaned) return "";
			return cleaned.length > 8000
				? `${cleaned.slice(0, 8000).trimEnd()}…`
				: cleaned;
		}

		function isCount(value) {
			return (
				typeof value === "number" && Number.isSafeInteger(value) && value >= 0
			);
		}

		function emptyBuckets() {
			return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		}

		function addBuckets(left, right) {
			return {
				input: left.input + right.input,
				output: left.output + right.output,
				cacheRead: left.cacheRead + right.cacheRead,
				cacheWrite: left.cacheWrite + right.cacheWrite,
			};
		}

		function subtractBuckets(left, right) {
			return {
				input: Math.max(0, left.input - right.input),
				output: Math.max(0, left.output - right.output),
				cacheRead: Math.max(0, left.cacheRead - right.cacheRead),
				cacheWrite: Math.max(0, left.cacheWrite - right.cacheWrite),
			};
		}

		function sumBuckets(buckets) {
			return (
				buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite
			);
		}

		function bucketsFromUsage(usage) {
			if (!usage) return null;
			const input = usage.inputTokens;
			const output = usage.outputTokens;
			const cacheRead =
				usage.cacheReadTokens === undefined ? 0 : usage.cacheReadTokens;
			const cacheWrite =
				usage.cacheWriteTokens === undefined ? 0 : usage.cacheWriteTokens;
			if (
				!isCount(input) ||
				!isCount(output) ||
				!isCount(cacheRead) ||
				!isCount(cacheWrite)
			)
				return null;
			return { input, output, cacheRead, cacheWrite };
		}

		function bucketsFromProjection(value) {
			if (!value) return null;
			return bucketsFromUsage({
				inputTokens: value.uncachedInputTokens,
				outputTokens: value.outputTokens,
				cacheReadTokens: value.cacheReadTokens,
				cacheWriteTokens: value.cacheWriteTokens,
			});
		}

		function streamUsage(stream) {
			if (!Array.isArray(stream)) return undefined;
			for (let index = stream.length - 1; index >= 0; index -= 1) {
				const entry = stream[index];
				if (entry?.type === "chunk" && entry.chunk?.type === "usage")
					return entry.chunk.usage;
			}
			return undefined;
		}

		function readPriceOverrides() {
			try {
				const raw = localStorage.getItem(STORAGE.prices);
				if (!raw) return {};
				const parsed = JSON.parse(raw);
				return parsed && typeof parsed === "object" ? parsed : {};
			} catch {
				return {};
			}
		}

		function rateObject(value) {
			if (!value || typeof value !== "object") return null;
			const input = Number(value.input);
			const output = Number(value.output);
			const cacheRead =
				value.cacheRead === undefined ? 0 : Number(value.cacheRead);
			const cacheWrite =
				value.cacheWrite === undefined ? 0 : Number(value.cacheWrite);
			for (const number of [input, output, cacheRead, cacheWrite]) {
				if (!Number.isFinite(number) || number < 0) return null;
			}
			return { input, output, cacheRead, cacheWrite };
		}

		function normalizePrice(value) {
			if (!value || typeof value !== "object") return null;
			const currency =
				typeof value.currency === "string" && value.currency
					? value.currency.toUpperCase()
					: "CNY";
			const peak = rateObject(value.peak ?? value);
			const idle = rateObject(value.idle ?? value);
			if (!peak || !idle) return null;
			return { currency, peak, idle };
		}

		function priceFor(route) {
			if (!route?.provider || !route?.model) return null;
			const overrides = readPriceOverrides();
			const key = `${route.provider}/${route.model}`;
			if (Object.hasOwn(overrides, key)) {
				const normalized = normalizePrice(overrides[key]);
				if (normalized) return normalized;
			}
			if (!/deepseek/i.test(route.provider)) return null;
			const preset = DEEPSEEK_PRICING[route.model];
			return preset ? normalizePrice(preset) : null;
		}

		/** 北京时间工作日 9:00–12:00、14:00–18:00 为高峰；节假日未单独建模。 */
		function isPeakTime(time) {
			if (!Number.isFinite(time)) return false;
			const beijing = new Date(time + 8 * 60 * 60 * 1000);
			const day = beijing.getUTCDay();
			if (day === 0 || day === 6) return false;
			const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
			return (
				(minutes >= 9 * 60 && minutes < 12 * 60) ||
				(minutes >= 14 * 60 && minutes < 18 * 60)
			);
		}

		function priceBuckets(buckets, route, time) {
			if (!buckets) return null;
			const price = priceFor(route);
			if (!price) return null;
			const rates = isPeakTime(time) ? price.peak : price.idle;
			const amount =
				(buckets.input * rates.input +
					buckets.cacheRead * rates.cacheRead +
					buckets.cacheWrite * rates.cacheWrite +
					buckets.output * rates.output) /
				1_000_000;
			if (!Number.isFinite(amount)) return null;
			return { amount, currency: price.currency };
		}

		function formatTokens(value) {
			const number = Number.isFinite(value)
				? Math.max(0, Math.round(value))
				: 0;
			try {
				return number.toLocaleString("zh-CN");
			} catch {
				return String(number);
			}
		}

		function formatCost(amount, currency, copy) {
			if (!Number.isFinite(amount)) return copy.costUnavailable;
			const symbol = currency === "USD" ? "$" : "¥";
			if (amount === 0) return `${copy.approx}${symbol}0`;
			const abs = Math.abs(amount);
			const digits = abs >= 10 ? 2 : abs >= 0.01 ? 3 : 4;
			return `${copy.approx}${symbol}${amount.toFixed(digits)}`;
		}

		function Icon({ name }) {
			const shared = {
				width: 16,
				height: 16,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.7,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
			};
			if (name === "alert") {
				return h("svg", shared, [
					h("path", { key: "a", d: "M8 2.4 14.2 13H1.8L8 2.4Z" }),
					h("path", { key: "b", d: "M8 6.2v3.2" }),
					h("path", { key: "c", d: "M8 11.6h.01" }),
				]);
			}
			if (name === "stop") {
				return h("svg", shared, [
					h("rect", {
						key: "a",
						x: 3.2,
						y: 3.2,
						width: 9.6,
						height: 9.6,
						rx: 1.6,
					}),
				]);
			}
			if (name === "pause") {
				return h("svg", shared, [
					h("path", { key: "a", d: "M6 3.5v9" }),
					h("path", { key: "b", d: "M10 3.5v9" }),
				]);
			}
			return h("svg", shared, [
				h("path", { key: "a", d: "m3.4 8.3 3 3 6.2-6.8" }),
			]);
		}

		function ToastCard({ item, copy, onClose, onOpen }) {
			const [closing, setClosing] = useState(false);
			const [paused, setPaused] = useState(false);
			const [hidden, setHidden] = useState(
				() =>
					typeof document !== "undefined" &&
					document.visibilityState === "hidden",
			);
			const closeTimer = useRef(null);
			const cardRef = useRef(null);

			useEffect(() => {
				const card = cardRef.current;
				if (
					!card ||
					typeof card.addEventListener !== "function" ||
					typeof document === "undefined"
				)
					return;
				const onWheel = (event) => {
					forwardWheel(card, event);
				};
				card.addEventListener("wheel", onWheel, { passive: false });
				return () => card.removeEventListener("wheel", onWheel);
			}, []);

			// 页面在后台时先别让计时跑完：用户回来时通知还应该在。
			useEffect(() => {
				if (
					typeof document === "undefined" ||
					typeof document.addEventListener !== "function"
				)
					return;
				const onVisibility = () =>
					setHidden(document.visibilityState === "hidden");
				document.addEventListener("visibilitychange", onVisibility);
				onVisibility();
				return () =>
					document.removeEventListener("visibilitychange", onVisibility);
			}, []);

			const dismiss = useCallback(() => {
				if (closing) return;
				setClosing(true);
				closeTimer.current = setTimeout(() => onClose(item.id), 180);
			}, [closing, item.id, onClose]);

			useEffect(
				() => () => {
					if (closeTimer.current !== null) clearTimeout(closeTimer.current);
				},
				[],
			);

			const duration = Math.max(2000, Number(item.durationMs) || 5000);
			const meta = item.elapsed ? formatDuration(item.elapsed, copy) : "";

			return h(
				"div",
				{
					ref: cardRef,
					className: `dtt-card dtt-${item.tone}${closing ? " dtt-closing" : ""}`,
					role: "status",
					"data-session-id": item.sessionId,
					onMouseEnter: () => setPaused(true),
					onMouseLeave: () => setPaused(false),
				},
				h("div", { className: "dtt-icon" }, h(Icon, { name: item.icon })),
				h(
					"div",
					{ className: "dtt-main" },
					h(
						"div",
						{ className: "dtt-head" },
						h("span", { className: "dtt-title" }, item.title),
						h("span", { className: "dtt-time" }, item.timeLabel),
						h(
							"button",
							{
								type: "button",
								className: "dtt-close",
								title: copy.close,
								"aria-label": copy.close,
								onClick: dismiss,
							},
							"×",
						),
					),
					h(
						"div",
						{ className: "dtt-body" },
						h("span", { className: "dtt-session" }, `「${item.sessionTitle}」`),
						item.body,
					),
					item.stats
						? h(
								"div",
								{ className: "dtt-stats", title: item.stats.hint },
								h(
									"div",
									{ className: "dtt-stat-row" },
									h("span", { className: "dtt-stat-label" }, copy.turnLabel),
									h(
										"span",
										{ className: "dtt-stat-tokens" },
										`${formatTokens(item.stats.turnTokens)} ${copy.tokens}`,
									),
									h(
										"span",
										{
											className: `dtt-stat-cost${item.stats.turnCost === null ? " unknown" : ""}`,
										},
										item.stats.turnCost === null
											? copy.costUnavailable
											: formatCost(
													item.stats.turnCost,
													item.stats.currency,
													copy,
												),
									),
								),
								h(
									"div",
									{ className: "dtt-stat-row" },
									h("span", { className: "dtt-stat-label" }, copy.totalLabel),
									h(
										"span",
										{ className: "dtt-stat-tokens" },
										`${formatTokens(item.stats.totalTokens)} ${copy.tokens}`,
									),
									h(
										"span",
										{
											className: `dtt-stat-cost${item.stats.totalCost === null ? " unknown" : ""}`,
										},
										item.stats.totalCost === null
											? copy.costUnavailable
											: formatCost(
													item.stats.totalCost,
													item.stats.currency,
													copy,
												),
									),
								),
							)
						: null,
					item.snippet
						? h("div", { className: "dtt-snippet" }, item.snippet)
						: null,
					h(
						"div",
						{ className: "dtt-foot" },
						h(
							"button",
							{
								type: "button",
								className: "dtt-open",
								onClick: () => {
									onOpen(item.sessionId);
									dismiss();
								},
							},
							copy.open,
							h("span", { className: "dtt-arrow" }, "→"),
						),
						meta
							? h("span", { className: "dtt-meta" }, copy.duration(meta))
							: null,
					),
				),
				h("div", {
					className: "dtt-progress",
					style: {
						animationDuration: `${duration}ms`,
						animationPlayState: paused || hidden ? "paused" : "running",
					},
					onAnimationEnd: (event) => {
						if (event.target === event.currentTarget) dismiss();
					},
				}),
			);
		}

		let activeStore = null;

		function apply(ctx) {
			// 插件热重载时立刻刷新旧 <style> 标签，不必等到第一张卡出现。
			try {
				installStyle();
			} catch {}
			const store = createStore();
			activeStore = store;
			const copy = makeCopy();
			const watched = new Map();
			/** running 会话由本插件临时 retain，保证切走以后也能拿到精确的 turn/end。 */
			const retained = new Map();
			const previousRunning = new Map();
			const fallbackTimers = new Map();
			const turnStartedAt = new Map();
			const replyPreview = new Map();
			/** 当前这一轮是否已经用事件/兜底收过尾，避免同一个 running 门再弹一次。 */
			const episodeEnded = new Map();
			/** 已经处理过的 turn/end seq，防止同一条事件被重复发布。 */
			const lastEndSeq = new Map();
			/** 最近一次兜底通知的时间，用来吞掉随后迟到的 turn/end。 */
			const lastFallbackAt = new Map();

			let disposed = false;
			let sequence = 0;
			let scanTimer = null;

			const safeBinding = (sessionId) => {
				try {
					return ctx.sessions.binding(sessionId);
				} catch {
					return undefined;
				}
			};

			const openSession = (sessionId) => {
				try {
					const workspace = ctx.uiWorkspace;
					if (workspace && typeof workspace.openSession === "function")
						workspace.openSession(sessionId);
				} catch (error) {
					try {
						console.warn("[dsh-task-toast] 打开会话失败", error);
					} catch {}
				}
			};

			let systemOverlay = false;
			let actionTimer = null;

			const isDarkTheme = () => {
				try {
					return document.body?.hasAttribute("data-ds-dark-theme") === true;
				} catch {
					return true;
				}
			};

			const startActions = () => {
				if (actionTimer !== null || disposed) return;
				actionTimer = setInterval(async () => {
					try {
						const response = await fetch(`${API_BASE}/actions`, {
							cache: "no-store",
						});
						const data = await response.json().catch(() => ({}));
						for (const action of data?.actions || []) {
							if (
								action?.type === "open" &&
								typeof action.sessionId === "string" &&
								action.sessionId
							) {
								openSession(action.sessionId);
							}
						}
					} catch {}
				}, 900);
			};

			const checkCapabilities = async () => {
				if (disposed || typeof fetch !== "function") return false;
				try {
					const response = await fetch(`${API_BASE}/capabilities`, {
						cache: "no-store",
					});
					const data = await response.json();
					systemOverlay = data?.systemOverlay === true;
				} catch {
					systemOverlay = false;
				}
				if (systemOverlay) startActions();
				return systemOverlay;
			};

			const sendSystemNotification = async (payload) => {
				if (
					typeof fetch !== "function" ||
					typeof AbortController !== "function"
				)
					return false;
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 1800);
				try {
					const response = await fetch(`${API_BASE}/notify`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							accept: "application/json",
						},
						body: JSON.stringify(payload),
						signal: controller.signal,
					});
					const data = await response.json().catch(() => ({}));
					return response.ok && data?.ok === true;
				} catch {
					return false;
				} finally {
					clearTimeout(timer);
				}
			};

			const usageStates = new Map();

			const usageStateFor = (sessionId) => {
				let state = usageStates.get(sessionId);
				if (!state) {
					state = {
						route: undefined,
						prior: null,
						priorCaptured: false,
						observed: emptyBuckets(),
						observedCost: 0,
						observedCostKnown: true,
						observedLast: null,
						turn: null,
						currency: "CNY",
					};
					usageStates.set(sessionId, state);
				}
				return state;
			};

			const readProjection = (binding) => {
				try {
					const value = binding?.session?.projections?.get?.("tokenUsage");
					return bucketsFromProjection(value);
				} catch {
					return null;
				}
			};

			/**
			 * 会话已有的历史用量：首次读到 tokenUsage 投影时，减去插件已经观察到的部分。
			 * 只捕获一次，之后只靠事件累加；避免控制流与事件流先后顺序不同导致重复计数。
			 */
			const capturePrior = (state, binding) => {
				if (state.priorCaptured) return;
				const current = readProjection(binding);
				if (!current) return;
				state.prior = subtractBuckets(current, state.observed);
				state.priorCaptured = true;
			};

			const startTurn = (state, binding, turnNumber) => {
				state.turn = {
					number: turnNumber ?? null,
					startProjection: readProjection(binding),
					observed: emptyBuckets(),
					observedCost: 0,
					observedCostKnown: true,
					observedLast: null,
				};
			};

			/** 同一 turn/step 的新样本替换旧样本（重试），不同 step 则累加。 */
			const addSampleTo = (holder, key, buckets, cost, turn, step) => {
				const lastKey = `${key}Last`;
				const costKey = `${key}Cost`;
				const last = holder[lastKey];
				if (last && last.turn === turn && last.step === step) {
					holder[key] = subtractBuckets(holder[key], last.buckets);
					holder[costKey] = Math.max(0, holder[costKey] - last.cost);
				}
				holder[key] = addBuckets(holder[key], buckets);
				holder[costKey] = (holder[costKey] ?? 0) + cost;
				holder[lastKey] = { turn, step, buckets, cost };
			};

			const applyUsageSample = (
				sessionId,
				binding,
				usage,
				route,
				time,
				turn,
				step,
			) => {
				const buckets = bucketsFromUsage(usage);
				if (!buckets) return;
				const state = usageStateFor(sessionId);
				if (route?.provider && route?.model) state.route = route;
				if (!state.turn) startTurn(state, binding, turn);
				const priced = priceBuckets(buckets, state.route, time);
				const cost = priced ? priced.amount : 0;
				if (priced) state.currency = priced.currency;
				if (!priced) state.observedCostKnown = false;
				if (!priced && state.turn) state.turn.observedCostKnown = false;
				const safeTurn = Number.isFinite(turn) ? turn : -1;
				const safeStep = Number.isFinite(step) ? step : -1;
				addSampleTo(state, "observed", buckets, cost, safeTurn, safeStep);
				if (state.turn)
					addSampleTo(
						state.turn,
						"observed",
						buckets,
						cost,
						safeTurn,
						safeStep,
					);
				capturePrior(state, binding);
			};

			const finalizeTurn = (sessionId, binding, at) => {
				const state = usageStateFor(sessionId);
				capturePrior(state, binding);
				const current = readProjection(binding);
				const turn = state.turn;
				const observedTurn = turn ? turn.observed : emptyBuckets();

				// 本次任务：优先用 tokenUsage 投影在 turn 前后的差值（覆盖插件没看到的步骤）；
				// 投影晚一帧、差值还没覆盖观察值时，退回实际观察值，防止漏掉最后一个回复。
				let turnBuckets = observedTurn;
				if (turn?.startProjection && current) {
					const delta = subtractBuckets(current, turn.startProjection);
					// token 总量可能因重试替换而不单调；只有投影差值覆盖了观察值才采用它。
					if (sumBuckets(delta) >= sumBuckets(observedTurn))
						turnBuckets = delta;
				}

				let turnCost = null;
				if (turn) {
					const missing = subtractBuckets(turnBuckets, observedTurn);
					const missingPrice =
						sumBuckets(missing) > 0
							? priceBuckets(missing, state.route, at)
							: null;
					if (
						turn.observedCostKnown &&
						(sumBuckets(missing) === 0 || missingPrice)
					) {
						turnCost = turn.observedCost + (missingPrice?.amount ?? 0);
						if (missingPrice) state.currency = missingPrice.currency;
					}
				}

				// 对话累计：插件启动前的历史（prior）+ 启动后观察到的用量。
				let totalBuckets = addBuckets(
					state.prior ?? emptyBuckets(),
					state.observed,
				);
				// 投影比「历史 + 观察」多出来的部分（例如断线期间漏掉的事件）单独按当前价补上。
				let unaccounted = emptyBuckets();
				if (current && sumBuckets(current) >= sumBuckets(totalBuckets)) {
					unaccounted = subtractBuckets(current, totalBuckets);
					totalBuckets = current;
				}

				let totalCost = null;
				if (state.observedCostKnown) {
					const priorBuckets = state.prior;
					const priorPrice =
						priorBuckets && sumBuckets(priorBuckets) > 0
							? priceBuckets(priorBuckets, state.route, at)
							: null;
					const unaccountedPrice =
						sumBuckets(unaccounted) > 0
							? priceBuckets(unaccounted, state.route, at)
							: null;
					if (
						(!priorBuckets || sumBuckets(priorBuckets) === 0 || priorPrice) &&
						(sumBuckets(unaccounted) === 0 || unaccountedPrice)
					) {
						totalCost =
							state.observedCost +
							(priorPrice?.amount ?? 0) +
							(unaccountedPrice?.amount ?? 0);
						if (unaccountedPrice) state.currency = unaccountedPrice.currency;
						else if (priorPrice) state.currency = priorPrice.currency;
					}
				}

				const stats = {
					turnTokens: sumBuckets(turnBuckets),
					turnCost:
						turnCost !== null && Number.isFinite(turnCost) ? turnCost : null,
					totalTokens: sumBuckets(totalBuckets),
					totalCost:
						totalCost !== null && Number.isFinite(totalCost) ? totalCost : null,
					currency: state.currency || "CNY",
					scope: state.priorCaptured ? "full" : "observed",
				};
				state.turn = null;
				return stats;
			};

			const notify = (sessionId, reason, at, stats) => {
				if (disposed) return;
				const settings = readSettings();
				if (!settings.enabled) return;

				let row;
				try {
					row = ctx.sessions.list.getSnapshot().byId[sessionId];
				} catch {
					return;
				}
				if (!row || row.origin === "subagent") return;

				const preset = copy.reasons[reason] || copy.reasons.unknown;
				const started = turnStartedAt.get(sessionId);
				const elapsed = started ? Math.max(0, at - started) : 0;
				const timeLabel = new Date(at).toLocaleTimeString(undefined, {
					hour: "2-digit",
					minute: "2-digit",
				});

				const hint = !stats
					? copy.pricingUnknown
					: `${stats.totalCost === null ? copy.pricingUnknown : copy.costHint}${
							stats.scope === "observed" ? ` ${copy.observedOnly}` : ""
						}`;

				const item = {
					id: `dsh-task-toast-${Date.now()}-${++sequence}`,
					sessionId,
					title: preset.title,
					body: preset.body,
					tone: preset.tone,
					icon: preset.icon,
					sessionTitle: row.displayTitle || copy.untitled,
					snippet: previewText(replyPreview.get(sessionId) || ""),
					elapsed,
					timeLabel,
					durationMs: settings.duration,
					stats: stats ? { ...stats, hint } : null,
				};

				if (systemOverlay) {
					const turnCost =
						stats && stats.turnCost !== null ? stats.turnCost : null;
					const totalCost =
						stats && stats.totalCost !== null ? stats.totalCost : null;
					const currency = stats?.currency || "CNY";
					const payload = {
						id: item.id,
						sessionId,
						title: item.title,
						body: item.body,
						sessionTitle: item.sessionTitle,
						detail: detailText(replyPreview.get(sessionId) || ""),
						tone: item.tone,
						theme: isDarkTheme() ? "dark" : "light",
						timeLabel,
						durationText: elapsed
							? copy.duration(formatDuration(elapsed, copy))
							: "",
						durationMs: Math.max(3000, settings.duration),
						labels: {
							turn: copy.turnLabel,
							total: copy.totalLabel,
							open: copy.open,
							close: copy.close,
						},
						stats: {
							turnTokensText: `${formatTokens(stats?.turnTokens ?? 0)} ${copy.tokens}`,
							turnCostText:
								turnCost === null
									? copy.costUnavailable
									: formatCost(turnCost, currency, copy),
							totalTokensText: `${formatTokens(stats?.totalTokens ?? 0)} ${copy.tokens}`,
							totalCostText:
								totalCost === null
									? copy.costUnavailable
									: formatCost(totalCost, currency, copy),
						},
					};
					void sendSystemNotification(payload).then((ok) => {
						if (!ok) store.push(item);
					});
					return;
				}

				store.push(item);
			};

			const onEntry = (sessionId, binding, entry) => {
				const event = entry?.event;
				if (!event) return;
				const at = typeof event.time === "number" ? event.time : Date.now();
				const state = usageStateFor(sessionId);

				if (event.type === "request/header") {
					const config = event.data?.header?.config;
					if (config?.provider && config?.model) {
						state.route = { provider: config.provider, model: config.model };
					}
					capturePrior(state, binding);
					return;
				}

				if (event.type === "turn/start") {
					turnStartedAt.set(sessionId, at);
					replyPreview.delete(sessionId);
					episodeEnded.delete(sessionId);
					const pendingFallback = fallbackTimers.get(sessionId);
					if (pendingFallback !== undefined) {
						clearTimeout(pendingFallback);
						fallbackTimers.delete(sessionId);
					}
					startTurn(state, binding, event.data?.turn);
					capturePrior(state, binding);
					return;
				}

				if (event.type === "assistant/message") {
					const text = assistantText(event);
					if (text) replyPreview.set(sessionId, text);
					const source = event.data?.message?.source;
					const route =
						source?.provider && source?.model
							? { provider: source.provider, model: source.model }
							: state.route;
					const usage = event.data?.usage ?? streamUsage(event.data?.stream);
					if (usage) {
						applyUsageSample(
							sessionId,
							binding,
							usage,
							route,
							at,
							event.data?.turn,
							event.data?.step,
						);
					} else {
						capturePrior(state, binding);
					}
					return;
				}

				if (event.type === "assistant/attempt") {
					const usage = streamUsage(event.data?.stream);
					if (usage) {
						applyUsageSample(
							sessionId,
							binding,
							usage,
							state.route,
							at,
							event.data?.turn,
							event.data?.step,
						);
					}
					return;
				}

				if (event.type === "llm/retry-started") {
					const turn = event.data?.turn;
					const step = event.data?.step;
					if (
						state.observedLast &&
						state.observedLast.turn === turn &&
						state.observedLast.step === step
					) {
						state.observedLast = null;
					}
					if (
						state.turn?.observedLast &&
						state.turn.observedLast.turn === turn &&
						state.turn.observedLast.step === step
					) {
						state.turn.observedLast = null;
					}
					return;
				}

				if (event.type !== "turn/end") return;

				if (
					typeof event.seq === "number" &&
					lastEndSeq.get(sessionId) === event.seq
				)
					return;
				if (typeof event.seq === "number") lastEndSeq.set(sessionId, event.seq);

				const wasFallback = episodeEnded.get(sessionId) === "fallback";
				episodeEnded.set(sessionId, "event");

				const timer = fallbackTimers.get(sessionId);
				if (timer !== undefined) {
					clearTimeout(timer);
					fallbackTimers.delete(sessionId);
				}

				if (
					wasFallback &&
					Date.now() - (lastFallbackAt.get(sessionId) ?? 0) < FALLBACK_QUIET_MS
				)
					return;

				const reason = event.data?.reason?.kind || "completed";
				const stats = finalizeTurn(sessionId, binding, at);
				notify(sessionId, reason, at, stats);
			};

			const releaseRetained = (sessionId) => {
				const record = retained.get(sessionId);
				if (!record) return;
				retained.delete(sessionId);
				if (record.timer !== null) clearTimeout(record.timer);
				try {
					record.reference.release();
				} catch {}
			};

			/**
			 * 只保留正在运行的会话：这样即使用户切到别的对话，旧会话也不会被 UI
			 * 释放掉事件源，turn/end 仍能精确区分 completed / error / aborted。
			 */
			const ensureRetained = (sessionId, running) => {
				const record = retained.get(sessionId);
				if (running) {
					if (record) {
						if (record.timer !== null) {
							clearTimeout(record.timer);
							record.timer = null;
						}
						return;
					}
					// 当前打开的会话已经被 Chat 保留，不需要再叠一层引用。
					if (safeBinding(sessionId)) return;
					try {
						const reference = ctx.sessions.retain(sessionId, {
							source: "dsh-task-toast",
						});
						retained.set(sessionId, { reference, timer: null });
						reference.ready?.then(
							() => {
								if (disposed) return;
								const binding = safeBinding(sessionId);
								if (binding) {
									const current = watched.get(sessionId);
									if (!current || current.binding !== binding) {
										current?.dispose();
										watched.set(sessionId, {
											binding,
											dispose: attach(sessionId, binding),
										});
									}
								}
							},
							() => {},
						);
					} catch {}
					return;
				}
				if (record && record.timer === null) {
					record.timer = setTimeout(
						() => releaseRetained(sessionId),
						RELEASE_GRACE_MS,
					);
				}
			};

			const attach = (sessionId, binding) => {
				const listener = () => {
					let snapshot;
					try {
						snapshot = binding.eventSource.getSnapshot();
					} catch {
						return;
					}
					const change = snapshot?.change;
					if (change?.kind !== "append") return;
					for (const entry of change.entries || [])
						onEntry(sessionId, binding, entry);
				};
				let unsubscribe;
				try {
					unsubscribe = binding.eventSource.subscribe(listener);
				} catch {
					return () => {};
				}
				try {
					capturePrior(usageStateFor(sessionId), binding);
				} catch {}
				return () => {
					try {
						unsubscribe?.();
					} catch {}
				};
			};

			const scan = () => {
				if (disposed) return;
				let snapshot;
				try {
					snapshot = ctx.sessions.list.getSnapshot();
				} catch {
					return;
				}
				const ids = Array.isArray(snapshot?.ids) ? snapshot.ids : [];
				const byId = snapshot?.byId || {};
				const live = new Set(ids);

				for (const sessionId of ids) {
					const row = byId[sessionId];
					if (!row) continue;
					const isSubagent = row.origin === "subagent";
					const running = row.running === true;

					if (isSubagent) releaseRetained(sessionId);
					else ensureRetained(sessionId, running);

					const binding = isSubagent ? undefined : safeBinding(sessionId);
					const record = watched.get(sessionId);
					if (binding && (!record || record.binding !== binding)) {
						record?.dispose();
						watched.set(sessionId, {
							binding,
							dispose: attach(sessionId, binding),
						});
					} else if (!binding && record) {
						record.dispose();
						watched.delete(sessionId);
					}

					if (binding) {
						const usageState = usageStateFor(sessionId);
						capturePrior(usageState, binding);
						if (running && !usageState.turn)
							startTurn(usageState, binding, null);
					}

					const before = previousRunning.get(sessionId);

					if (before === undefined) {
						previousRunning.set(sessionId, running);
						if (running) turnStartedAt.set(sessionId, Date.now());
						continue;
					}

					if (before && !running) {
						previousRunning.set(sessionId, false);
						if (fallbackTimers.has(sessionId)) continue;
						if (episodeEnded.has(sessionId)) continue;
						const timer = setTimeout(() => {
							fallbackTimers.delete(sessionId);
							if (disposed) return;
							if (episodeEnded.has(sessionId)) return;
							episodeEnded.set(sessionId, "fallback");
							const at = Date.now();
							lastFallbackAt.set(sessionId, at);
							const stats = finalizeTurn(sessionId, safeBinding(sessionId), at);
							notify(sessionId, "completed", at, stats);
						}, FALLBACK_DELAY_MS);
						fallbackTimers.set(sessionId, timer);
					} else if (!before && running) {
						previousRunning.set(sessionId, true);
						turnStartedAt.set(sessionId, Date.now());
						replyPreview.delete(sessionId);
						episodeEnded.delete(sessionId);
						lastEndSeq.delete(sessionId);
						const pendingFallback = fallbackTimers.get(sessionId);
						if (pendingFallback !== undefined) {
							clearTimeout(pendingFallback);
							fallbackTimers.delete(sessionId);
						}
						const usageState = usageStateFor(sessionId);
						if (!usageState.turn)
							startTurn(usageState, safeBinding(sessionId), null);
					}
				}

				for (const [sessionId, record] of watched) {
					if (!live.has(sessionId)) {
						record.dispose();
						watched.delete(sessionId);
						releaseRetained(sessionId);
					}
				}

				for (const sessionId of [...previousRunning.keys()]) {
					if (live.has(sessionId)) continue;
					previousRunning.delete(sessionId);
					turnStartedAt.delete(sessionId);
					replyPreview.delete(sessionId);
					episodeEnded.delete(sessionId);
					lastEndSeq.delete(sessionId);
					lastFallbackAt.delete(sessionId);
					usageStates.delete(sessionId);
					const timer = fallbackTimers.get(sessionId);
					if (timer !== undefined) clearTimeout(timer);
					fallbackTimers.delete(sessionId);
				}
			};

			ctx.effect(() => {
				let unsubscribe = () => {};
				try {
					unsubscribe = ctx.sessions.list.subscribe(scan);
				} catch {}
				scan();
				if (typeof setInterval === "function") {
					scanTimer = setInterval(scan, SCAN_MS);
				}
				return () => {
					disposed = true;
					try {
						unsubscribe();
					} catch {}
					if (scanTimer !== null) clearInterval(scanTimer);
					scanTimer = null;
					if (actionTimer !== null) clearInterval(actionTimer);
					actionTimer = null;
					for (const timer of fallbackTimers.values()) clearTimeout(timer);
					fallbackTimers.clear();
					for (const record of watched.values()) record.dispose();
					watched.clear();
					for (const sessionId of [...retained.keys()])
						releaseRetained(sessionId);
					usageStates.clear();
					store.clear();
				};
			}, "dsh-task-toast: session watchers");

			// 系统级置顶窗口由宿主侧提供；能力探测失败时保持网页内通知作为兜底。
			void checkCapabilities().then((ok) => {
				if (!ok && !disposed && typeof fetch === "function") {
					setTimeout(() => void checkCapabilities(), 2500);
				}
			});

			const open = (sessionId) => openSession(sessionId);

			function ToastHost() {
				useStyleOnce();
				const items = useSyncExternalStore(store.subscribe, store.getSnapshot);
				const api = useMemo(() => ({ close: store.remove, open }), []);
				if (items.length === 0) return null;
				return h(
					"div",
					{ className: "dtt-stack", role: "region", "aria-label": copy.region },
					items.map((item) =>
						h(ToastCard, {
							key: item.id,
							item,
							copy,
							onClose: api.close,
							onOpen: api.open,
						}),
					),
				);
			}

			ctx.effect(
				() =>
					ctx.slots.inject("shell.overlay", () =>
						ctx.slots.register(
							{ name: "shell.overlay", id: "dsh-task-toast" },
							ToastHost,
						),
					),
				"dsh-task-toast: overlay",
			);
		}

		const inject = ["slots", "sessions", "uiWorkspace"];

		return {
			inject,
			apply,
			/** 测试/诊断用：读取当前 apply 产生的通知列表。 */
			__toasts: () => (activeStore ? activeStore.getSnapshot() : []),
			__clearToasts: () => activeStore?.clear(),
			/** 测试/诊断用：滚轮转发。 */
			__forwardWheel: forwardWheel,
		};
	},
});
