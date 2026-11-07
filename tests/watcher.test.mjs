/**
 * 用 vm 加载真正的 lib/client.js，mock 掉 React 和 Cordis 上下文，
 * 验证「turn/end → 右下角通知」的核心逻辑：
 *
 *   - completed 通知带标题、摘要、耗时
 *   - 子代理会话不弹
 *   - 同一会话短时间重复上报只弹一次
 *   - 没有事件源时用 running 位兜底
 *   - 事件先到、running 后关时不重复
 *   - error 用错误样式文案
 *
 * 运行：node plugins/dsh-task-toast/tests/watcher.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
	path.join(here, "..", "lib", "client.js"),
	"utf8",
);

const noop = () => {};
const react = {
	createElement(type, props, ...children) {
		return { type, props: props ?? {}, children };
	},
	useState(value) {
		return [typeof value === "function" ? value() : value, noop];
	},
	useEffect: noop,
	useMemo: (factory) => factory(),
	useRef: (value) => ({ current: value }),
	useCallback: (fn) => fn,
	useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

function renderNode(node) {
	if (node === null || node === undefined || typeof node === "boolean")
		return null;
	if (Array.isArray(node)) return node.map(renderNode).filter(Boolean);
	if (typeof node !== "object") return String(node);
	if (typeof node.type === "function") return renderNode(node.type(node.props));
	return {
		type: node.type,
		props: node.props ?? {},
		children: node.children.map(renderNode).filter(Boolean),
	};
}

function walk(node, visit) {
	if (node === null || node === undefined) return;
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit);
		return;
	}
	if (typeof node !== "object") {
		visit({ type: "text", value: String(node) });
		return;
	}
	visit(node);
	for (const child of node.children ?? []) walk(child, visit);
}

function textOf(node) {
	let text = "";
	walk(node, (entry) => {
		if (entry.type === "text") text += entry.value;
	});
	return text;
}

let fetchImpl = null;
const storage = new Map();
const localStorageMock = {
	getItem: (key) => (storage.has(key) ? storage.get(key) : null),
	setItem: (key, value) => storage.set(key, String(value)),
	removeItem: (key) => storage.delete(key),
};

let computedStyle = () => ({ overflowY: "hidden" });

let captured = null;
const sandbox = {
	window: {
		__ModuleLoader__: {
			load(definition) {
				captured = definition;
			},
		},
	},
	document: {
		documentElement: { getAttribute: () => "zh-CN" },
		body: {},
		getElementById: () => null,
		createElement: () => ({
			set id(value) {
				void value;
			},
			set textContent(value) {
				void value;
			},
		}),
		head: { appendChild() {} },
		elementsFromPoint: () => [],
	},
	navigator: { language: "zh-CN" },
	localStorage: localStorageMock,
	getComputedStyle: (node) => computedStyle(node),
	fetch: (...args) => {
		if (!fetchImpl) throw new Error("fetch unavailable");
		return fetchImpl(...args);
	},
	AbortController,
	setTimeout,
	clearTimeout,
	setInterval: () => 0,
	clearInterval() {},
	console,
	Date,
	Math,
	Number,
	String,
	Array,
	Object,
	Set,
	Map,
	Promise,
	JSON,
};
vm.runInNewContext(source, sandbox, { filename: "client.js" });

assert.ok(captured, "客户端插件应该调用 window.__ModuleLoader__.load");
const plugin = captured.factory((id) => {
	if (id === "react") return react;
	throw new Error(`意外的 require: ${id}`);
});

function createList() {
	let snapshot = { ids: [], byId: {}, phase: "ready" };
	const listeners = new Set();
	return {
		getSnapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(next) {
			snapshot = next;
			for (const listener of [...listeners]) listener();
		},
	};
}

function createBinding() {
	let change = { kind: "replace", entries: [] };
	let revision = 0;
	let projection;
	const listeners = new Set();
	return {
		eventSource: {
			getSnapshot: () => ({ change, revision }),
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		session: {
			projections: {
				get: (key) => (key === "tokenUsage" ? projection : undefined),
			},
		},
		setProjection(value) {
			projection = value;
		},
		emit(event) {
			revision += 1;
			change = { kind: "append", entries: [{ type: "event", event }] };
			for (const listener of [...listeners]) listener();
		},
	};
}

function mount({ list, bindings }) {
	const disposers = [];
	const opened = [];
	const registrations = [];
	const retainedCalls = [];
	const released = [];
	const ctx = {
		effect(fn) {
			const dispose = fn();
			if (typeof dispose === "function") disposers.push(dispose);
		},
		slots: {
			inject(_name, callback) {
				return callback();
			},
			register(options, component) {
				registrations.push({ options, component });
				return () => {};
			},
		},
		sessions: {
			list,
			binding: (id) => bindings.get(id),
			retain(id, options) {
				retainedCalls.push({ id, source: options?.source });
				if (!bindings.has(id)) bindings.set(id, createBinding());
				return {
					ready: Promise.resolve(bindings.get(id)),
					release() {
						released.push(id);
					},
				};
			},
		},
		uiWorkspace: {
			openSession(id) {
				opened.push(id);
			},
		},
	};
	plugin.apply(ctx);
	return {
		toasts: () => plugin.__toasts(),
		clear: () => plugin.__clearToasts(),
		opened,
		retainedCalls,
		released,
		render() {
			assert.ok(registrations.length > 0, "应该把通知注册进 shell.overlay");
			const registration = registrations.at(-1);
			assert.equal(registration.options.name, "shell.overlay");
			assert.equal(registration.options.id, "dsh-task-toast");
			return renderNode(registration.component({}));
		},
		dispose: () => {
			for (const dispose of disposers.splice(0)) dispose();
		},
	};
}

function row(id, extra = {}) {
	return {
		id,
		displayTitle: `会话 ${id}`,
		running: false,
		blank: false,
		...extra,
	};
}

async function testCompletedToast() {
	const list = createList();
	const bindings = new Map();
	const binding = createBinding();
	bindings.set("s1", binding);
	list.set({
		ids: ["s1"],
		byId: { s1: row("s1", { displayTitle: "写一个提醒插件" }) },
		phase: "ready",
	});

	const app = mount({ list, bindings });

	list.set({
		ids: ["s1"],
		byId: { s1: row("s1", { displayTitle: "写一个提醒插件", running: true }) },
		phase: "ready",
	});

	const started = Date.now() - 5000;
	binding.emit({ type: "turn/start", time: started, data: {} });
	binding.emit({
		type: "assistant/message",
		time: started + 1000,
		data: {
			message: {
				content: [
					{ type: "text", text: "插件已经写好了，重启 DSH 后即可生效。" },
				],
			},
		},
	});
	binding.emit({
		type: "turn/end",
		time: Date.now(),
		data: { reason: { kind: "completed" } },
	});

	const toasts = app.toasts();
	assert.equal(toasts.length, 1, "完成一轮应出现一条通知");
	assert.equal(toasts[0].title, "任务已完成");
	assert.equal(toasts[0].sessionTitle, "写一个提醒插件");
	assert.match(toasts[0].snippet, /插件已经写好了/);
	assert.ok(toasts[0].elapsed >= 4000, "应带上本轮耗时");

	list.set({
		ids: ["s1"],
		byId: { s1: row("s1", { displayTitle: "写一个提醒插件", running: false }) },
		phase: "ready",
	});
	assert.equal(app.toasts().length, 1, "running 关闭不能重复弹");
	app.dispose();
}

async function testRenderedMarkup() {
	const list = createList();
	const bindings = new Map();
	const binding = createBinding();
	bindings.set("s1", binding);
	list.set({
		ids: ["s1"],
		byId: { s1: row("s1", { displayTitle: "写一个提醒插件" }) },
		phase: "ready",
	});

	const app = mount({ list, bindings });
	list.set({
		ids: ["s1"],
		byId: { s1: row("s1", { displayTitle: "写一个提醒插件", running: true }) },
		phase: "ready",
	});
	binding.emit({ type: "turn/start", time: Date.now() - 3000, data: {} });
	binding.emit({
		type: "assistant/message",
		time: Date.now() - 2000,
		data: {
			message: { content: [{ type: "text", text: "插件已经写好了。" }] },
		},
	});
	binding.emit({
		type: "turn/end",
		time: Date.now(),
		data: { reason: { kind: "completed" } },
	});

	const tree = app.render();
	const cards = [];
	walk(tree, (node) => {
		if (
			typeof node.props?.className === "string" &&
			node.props.className.includes("dtt-card")
		)
			cards.push(node);
	});
	assert.equal(cards.length, 1, "应该渲染一张卡片");
	assert.match(cards[0].props.className, /dtt-success/);

	const text = textOf(tree);
	assert.match(text, /任务已完成/);
	assert.match(text, /「写一个提醒插件」/);
	assert.match(text, /插件已经写好了/);
	assert.match(text, /查看对话/);
	assert.match(text, /用时/);

	let progress = null;
	walk(tree, (node) => {
		if (node.props?.className === "dtt-progress") progress = node;
	});
	assert.ok(progress, "应有自动消失进度条");
	assert.equal(progress.props.style.animationDuration, "5000ms");
	app.dispose();
}

async function testOpenConversationAction() {
	const list = createList();
	const bindings = new Map();
	const binding = createBinding();
	bindings.set("s-open", binding);
	list.set({
		ids: ["s-open"],
		byId: { "s-open": row("s-open") },
		phase: "ready",
	});

	const app = mount({ list, bindings });
	binding.emit({
		type: "turn/end",
		time: Date.now(),
		data: { reason: { kind: "completed" } },
	});

	const tree = app.render();
	let openButton = null;
	walk(tree, (node) => {
		if (node.props?.className === "dtt-open") openButton = node;
	});
	assert.ok(openButton, "应有“查看对话”按钮");
	openButton.props.onClick();
	await new Promise((resolve) => setTimeout(resolve, 220));

	assert.deepEqual(app.opened, ["s-open"], "点击后应打开对应会话");
	assert.equal(app.toasts().length, 0, "打开会话后通知应消失");
	app.dispose();
}

async function testDuplicateTurnEnd() {
	const list = createList();
	const bindings = new Map();
	const binding = createBinding();
	bindings.set("s2", binding);
	list.set({ ids: ["s2"], byId: { s2: row("s2") }, phase: "ready" });

	const app = mount({ list, bindings });
	binding.emit({
		type: "turn/end",
		seq: 42,
		time: Date.now(),
		data: { reason: { kind: "completed" } },
	});
	binding.emit({
		type: "turn/end",
		seq: 42,
		time: Date.now(),
		data: { reason: { kind: "completed" } },
	});
	assert.equal(app.toasts().length, 1, "同一个 seq 的 turn/end 应去重");

	// 紧接着的下一轮仍然应该提醒，不能被「同会话 N 秒内只弹一次」误吞。
	binding.emit({ type: "turn/start", seq: 43, time: Date.now(), data: {} });
	binding.emit({
		type: "turn/end",
		seq: 44,
		time: Date.now(),
		data: { reason: { kind: "completed" } },
	});
	assert.equal(app.toasts().length, 2, "连续两轮任务都应提醒");
	app.dispose();
}

async function testSubagentIgnored() {
	const list = createList();
	const bindings = new Map();
	const binding = createBinding();
	bindings.set("child", binding);
	list.set({
		ids: ["child"],
		byId: {
			child: row("child", { origin: "subagent", displayTitle: "子代理" }),
		},
		phase: "ready",
	});

	const app = mount({ list, bindings });
	binding.emit({
		type: "turn/end",
		time: Date.now(),
		data: { reason: { kind: "completed" } },
	});
	assert.equal(app.toasts().length, 0, "子代理结束不应打扰用户");
	app.dispose();
}

async function testRetainsBackgroundSession() {
	const list = createList();
	const bindings = new Map();
	list.set({
		ids: ["bg"],
		byId: { bg: row("bg", { running: true }) },
		phase: "ready",
	});

	const app = mount({ list, bindings });
	assert.equal(app.retainedCalls.length, 1, "运行中的后台会话应被临时 retain");
	assert.equal(app.retainedCalls[0].source, "dsh-task-toast");

	const binding = bindings.get("bg");
	assert.ok(binding, "retain 后应能拿到事件源");
	binding.emit({
		type: "turn/end",
		seq: 1,
		time: Date.now(),
		data: { reason: { kind: "error" } },
	});
	assert.equal(app.toasts().length, 1);
	assert.equal(app.toasts()[0].title, "任务执行失败");

	app.dispose();
	assert.deepEqual(app.released, ["bg"], "插件卸载时应释放引用");
}

function projection(
	uncachedInputTokens,
	outputTokens,
	cacheReadTokens = 0,
	cacheWriteTokens = 0,
) {
	return {
		uncachedInputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
	};
}

function emitUsageTurn(binding, { time, usage, route, text = "已完成。" }) {
	binding.emit({ type: "turn/start", time, data: { turn: 1 } });
	binding.emit({
		type: "assistant/message",
		time,
		data: {
			turn: 1,
			step: 1,
			usage,
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				source: { kind: "model", provider: route.provider, model: route.model },
			},
		},
	});
}

async function testUsagePeakPricing() {
	const list = createList();
	const bindings = new Map();
	const binding = createBinding();
	bindings.set("u-peak", binding);
	binding.setProjection(projection(1_000_000, 0));
	list.set({
		ids: ["u-peak"],
		byId: { "u-peak": row("u-peak") },
		phase: "ready",
	});

	const app = mount({ list, bindings });
	list.set({
		ids: ["u-peak"],
		byId: { "u-peak": row("u-peak", { running: true }) },
		phase: "ready",
	});

	const time = Date.UTC(2026, 10, 5, 2, 0); // 2026-11-05 10:00 Beijing, peak
	emitUsageTurn(binding, {
		time,
		usage: {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 1500,
		},
		route: { provider: "deepseek-account", model: "deepseek-flash" },
	});
	binding.setProjection(projection(1_001_000, 500));
	binding.emit({
		type: "turn/end",
		time: time + 1000,
		data: { turn: 1, reason: { kind: "completed" } },
	});

	const stats = app.toasts()[0].stats;
	assert.equal(stats.turnTokens, 1500);
	assert.equal(stats.totalTokens, 1_001_500);
	assert.ok(
		Math.abs(stats.turnCost - 0.006) < 1e-9,
		`turn cost ${stats.turnCost}`,
	);
	assert.ok(
		Math.abs(stats.totalCost - 2.006) < 1e-9,
		`total cost ${stats.totalCost}`,
	);
	assert.equal(stats.currency, "CNY");

	const tree = app.render();
	let statRows = 0;
	walk(tree, (node) => {
		if (node.props?.className === "dtt-stat-row") statRows += 1;
	});
	assert.equal(statRows, 2, "本次与累计必须各占一行");

	const text = textOf(tree);
	assert.match(text, /1,500 tokens/);
	assert.match(text, /1,001,500 tokens/);
	assert.match(text, /≈¥0.0060/);
	assert.match(text, /≈¥2.006/);
	app.dispose();
}

async function testUsageAttemptReplacement() {
	const list = createList();
	const bindings = new Map();
	const binding = createBinding();
	bindings.set("u-attempt", binding);
	binding.setProjection(projection(0, 0));
	list.set({
		ids: ["u-attempt"],
		byId: { "u-attempt": row("u-attempt") },
		phase: "ready",
	});

	const app = mount({ list, bindings });
	list.set({
		ids: ["u-attempt"],
		byId: { "u-attempt": row("u-attempt", { running: true }) },
		phase: "ready",
	});

	const time = Date.UTC(2026, 10, 5, 2, 0);
	binding.emit({
		type: "request/header",
		time,
		data: {
			header: {
				config: { provider: "deepseek-account", model: "deepseek-flash" },
			},
		},
	});
	binding.emit({ type: "turn/start", time, data: { turn: 1 } });
	binding.emit({
		type: "assistant/attempt",
		time,
		data: {
			turn: 1,
			step: 1,
			stream: [
				{
					type: "chunk",
					chunk: {
						type: "usage",
						usage: {
							inputTokens: 100,
							outputTokens: 50,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
						},
					},
				},
			],
		},
	});
	binding.emit({
		type: "assistant/message",
		time,
		data: {
			turn: 1,
			step: 1,
			usage: {
				inputTokens: 200,
				outputTokens: 100,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				source: {
					kind: "model",
					provider: "deepseek-account",
					model: "deepseek-flash",
				},
			},
		},
	});
	binding.setProjection(projection(200, 100));
	binding.emit({
		type: "turn/end",
		time: time + 1000,
		data: { turn: 1, reason: { kind: "completed" } },
	});

	const stats = app.toasts()[0].stats;
	assert.equal(
		stats.turnTokens,
		300,
		"同一步的 attempt 用量应被最终 message 替换，而不是相加",
	);
	assert.equal(stats.totalTokens, 300);
	app.dispose();
}

async function testUsageIdlePricing() {
	const list = createList();
	const bindings = new Map();
	const binding = createBinding();
	bindings.set("u-idle", binding);
	binding.setProjection(projection(0, 0));
	list.set({
		ids: ["u-idle"],
		byId: { "u-idle": row("u-idle") },
		phase: "ready",
	});

	const app = mount({ list, bindings });
	list.set({
		ids: ["u-idle"],
		byId: { "u-idle": row("u-idle", { running: true }) },
		phase: "ready",
	});

	const time = Date.UTC(2026, 10, 5, 12, 0); // 2026-11-05 20:00 Beijing, idle
	emitUsageTurn(binding, {
		time,
		usage: {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 2_000_000,
		},
		route: { provider: "deepseek-account", model: "deepseek-flash" },
	});
	binding.setProjection(projection(1_000_000, 1_000_000));
	binding.emit({
		type: "turn/end",
		time: time + 1000,
		data: { turn: 1, reason: { kind: "completed" } },
	});

	const stats = app.toasts()[0].stats;
	assert.equal(stats.turnTokens, 2_000_000);
	assert.ok(
		Math.abs(stats.turnCost - 5) < 1e-9,
		`idle turn cost ${stats.turnCost}`,
	);
	assert.ok(
		Math.abs(stats.totalCost - 5) < 1e-9,
		`idle total cost ${stats.totalCost}`,
	);
	app.dispose();
}

async function testUsageCachePricing() {
	const list = createList();
	const bindings = new Map();
	const binding = createBinding();
	bindings.set("u-cache", binding);
	binding.setProjection(projection(0, 0));
	list.set({
		ids: ["u-cache"],
		byId: { "u-cache": row("u-cache") },
		phase: "ready",
	});

	const app = mount({ list, bindings });
	list.set({
		ids: ["u-cache"],
		byId: { "u-cache": row("u-cache", { running: true }) },
		phase: "ready",
	});

	const time = Date.UTC(2026, 10, 5, 2, 0); // peak
	emitUsageTurn(binding, {
		time,
		usage: {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 1_000_000,
			cacheWriteTokens: 0,
			totalTokens: 1_000_000,
		},
		route: { provider: "deepseek-account", model: "deepseek-flash" },
	});
	binding.setProjection(projection(0, 0, 1_000_000));
	binding.emit({
		type: "turn/end",
		time: time + 1000,
		data: { turn: 1, reason: { kind: "completed" } },
	});

	const stats = app.toasts()[0].stats;
	assert.ok(
		Math.abs(stats.turnCost - 0.04) < 1e-9,
		`cache cost ${stats.turnCost}`,
	);
	app.dispose();
}

async function testUsageUnknownModel() {
	const list = createList();
	const bindings = new Map();
	const binding = createBinding();
	bindings.set("u-unknown", binding);
	binding.setProjection(projection(0, 0));
	list.set({
		ids: ["u-unknown"],
		byId: { "u-unknown": row("u-unknown") },
		phase: "ready",
	});

	const app = mount({ list, bindings });
	list.set({
		ids: ["u-unknown"],
		byId: { "u-unknown": row("u-unknown", { running: true }) },
		phase: "ready",
	});

	const time = Date.UTC(2026, 10, 5, 2, 0);
	emitUsageTurn(binding, {
		time,
		usage: {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 1500,
		},
		route: { provider: "openai", model: "gpt-5" },
	});
	binding.setProjection(projection(1000, 500));
	binding.emit({
		type: "turn/end",
		time: time + 1000,
		data: { turn: 1, reason: { kind: "completed" } },
	});

	const stats = app.toasts()[0].stats;
	assert.equal(stats.turnTokens, 1500);
	assert.equal(stats.totalTokens, 1500);
	assert.equal(stats.turnCost, null, "未配置价格时不应瞎算");
	assert.equal(stats.totalCost, null);
	const text = textOf(app.render());
	assert.match(text, /1500 tokens|1,500 tokens/);
	assert.match(text, /—/);
	app.dispose();
}

async function testPriceOverride() {
	localStorageMock.setItem(
		"dsh-task-toast.prices",
		JSON.stringify({
			"openai/gpt-5": {
				currency: "USD",
				input: 1,
				cacheRead: 0,
				cacheWrite: 0,
				output: 2,
			},
		}),
	);
	try {
		const list = createList();
		const bindings = new Map();
		const binding = createBinding();
		bindings.set("u-override", binding);
		binding.setProjection(projection(0, 0));
		list.set({
			ids: ["u-override"],
			byId: { "u-override": row("u-override") },
			phase: "ready",
		});

		const app = mount({ list, bindings });
		list.set({
			ids: ["u-override"],
			byId: { "u-override": row("u-override", { running: true }) },
			phase: "ready",
		});

		const time = Date.UTC(2026, 10, 5, 2, 0);
		emitUsageTurn(binding, {
			time,
			usage: {
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 2_000_000,
			},
			route: { provider: "openai", model: "gpt-5" },
		});
		binding.setProjection(projection(1_000_000, 1_000_000));
		binding.emit({
			type: "turn/end",
			time: time + 1000,
			data: { turn: 1, reason: { kind: "completed" } },
		});

		const stats = app.toasts()[0].stats;
		assert.ok(
			Math.abs(stats.turnCost - 3) < 1e-9,
			`override cost ${stats.turnCost}`,
		);
		assert.equal(stats.currency, "USD");
		app.dispose();
	} finally {
		localStorageMock.removeItem("dsh-task-toast.prices");
	}
}

async function testUsageObservedOnly() {
	const list = createList();
	const bindings = new Map();
	const binding = createBinding();
	bindings.set("u-observed", binding);
	// 不设置 projection：模拟没有 tokenUsage 投影的装配
	list.set({
		ids: ["u-observed"],
		byId: { "u-observed": row("u-observed") },
		phase: "ready",
	});

	const app = mount({ list, bindings });
	list.set({
		ids: ["u-observed"],
		byId: { "u-observed": row("u-observed", { running: true }) },
		phase: "ready",
	});

	const time = Date.UTC(2026, 10, 5, 2, 0);
	emitUsageTurn(binding, {
		time,
		usage: {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 1500,
		},
		route: { provider: "deepseek-account", model: "deepseek-flash" },
	});
	binding.emit({
		type: "turn/end",
		time: time + 1000,
		data: { turn: 1, reason: { kind: "completed" } },
	});

	const stats = app.toasts()[0].stats;
	assert.equal(stats.turnTokens, 1500);
	assert.equal(stats.totalTokens, 1500);
	assert.equal(stats.scope, "observed");
	assert.ok(Math.abs(stats.totalCost - 0.006) < 1e-9);
	app.dispose();
}

async function testSystemOverlayPath() {
	const posted = [];
	fetchImpl = async (url, options) => {
		const path = String(url);
		if (path.endsWith("/capabilities")) {
			return {
				ok: true,
				json: async () => ({ ok: true, systemOverlay: true }),
			};
		}
		if (path.endsWith("/notify")) {
			posted.push(JSON.parse(options.body));
			return { ok: true, json: async () => ({ ok: true }) };
		}
		if (path.endsWith("/actions")) {
			return { ok: true, json: async () => ({ ok: true, actions: [] }) };
		}
		throw new Error(`unexpected fetch ${path}`);
	};

	try {
		const list = createList();
		const bindings = new Map();
		const binding = createBinding();
		bindings.set("sys", binding);
		binding.setProjection(projection(0, 0));
		list.set({ ids: ["sys"], byId: { sys: row("sys") }, phase: "ready" });

		const app = mount({ list, bindings });
		await new Promise((resolve) => setTimeout(resolve, 0));
		list.set({
			ids: ["sys"],
			byId: { sys: row("sys", { running: true }) },
			phase: "ready",
		});

		const time = Date.UTC(2026, 10, 5, 2, 0);
		binding.emit({ type: "turn/start", time, data: { turn: 1 } });
		binding.emit({
			type: "assistant/message",
			time,
			data: {
				turn: 1,
				step: 1,
				usage: {
					inputTokens: 1000,
					outputTokens: 500,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				},
				message: {
					role: "assistant",
					content: [{ type: "text", text: "完整回复内容\n第二行" }],
					source: {
						kind: "model",
						provider: "deepseek-account",
						model: "deepseek-flash",
					},
				},
			},
		});
		binding.setProjection(projection(1000, 500));
		binding.emit({
			type: "turn/end",
			time: time + 1000,
			data: { turn: 1, reason: { kind: "completed" } },
		});
		await new Promise((resolve) => setTimeout(resolve, 20));

		assert.equal(
			app.toasts().length,
			0,
			"系统级窗口可用时不应再显示网页内卡片",
		);
		assert.equal(posted.length, 1, "应该把通知 POST 给宿主");
		assert.equal(posted[0].detail, "完整回复内容\n第二行");
		assert.equal(posted[0].durationMs, 5000);
		assert.equal(posted[0].stats.turnTokensText, "1,500 tokens");
		assert.match(posted[0].stats.turnCostText, /¥/);
		assert.equal(posted[0].stats.totalTokensText, "1,500 tokens");
		app.dispose();
	} finally {
		fetchImpl = null;
	}
}

async function testRunningFallback() {
	const list = createList();
	const bindings = new Map();
	list.set({ ids: ["s3"], byId: { s3: row("s3") }, phase: "ready" });

	const app = mount({ list, bindings });
	list.set({
		ids: ["s3"],
		byId: { s3: row("s3", { running: true }) },
		phase: "ready",
	});
	list.set({
		ids: ["s3"],
		byId: { s3: row("s3", { running: false }) },
		phase: "ready",
	});

	assert.equal(app.toasts().length, 0, "兜底要等一小会儿");
	await new Promise((resolve) => setTimeout(resolve, 1000));
	assert.equal(app.toasts().length, 1, "没有事件源时 running 位兜底");
	assert.equal(app.toasts()[0].title, "任务已完成");
	app.dispose();
}

async function testNewTurnCancelsFallback() {
	const list = createList();
	const bindings = new Map();
	const binding = createBinding();
	bindings.set("s-next", binding);
	list.set({
		ids: ["s-next"],
		byId: { "s-next": row("s-next") },
		phase: "ready",
	});

	const app = mount({ list, bindings });
	list.set({
		ids: ["s-next"],
		byId: { "s-next": row("s-next", { running: true }) },
		phase: "ready",
	});
	list.set({
		ids: ["s-next"],
		byId: { "s-next": row("s-next", { running: false }) },
		phase: "ready",
	});
	await new Promise((resolve) => setTimeout(resolve, 150));
	// 新的一轮在兜底定时器触发前开始
	list.set({
		ids: ["s-next"],
		byId: { "s-next": row("s-next", { running: true }) },
		phase: "ready",
	});
	await new Promise((resolve) => setTimeout(resolve, 1000));
	assert.equal(app.toasts().length, 0, "新一轮开始后不能再替上一轮兜底");

	binding.emit({
		type: "turn/end",
		seq: 9,
		time: Date.now(),
		data: { reason: { kind: "completed" } },
	});
	assert.equal(app.toasts().length, 1);
	app.dispose();
}

async function testLateEventAfterFallback() {
	const list = createList();
	const bindings = new Map();
	const binding = createBinding();
	bindings.set("s-late", binding);
	list.set({
		ids: ["s-late"],
		byId: { "s-late": row("s-late") },
		phase: "ready",
	});

	const app = mount({ list, bindings });
	list.set({
		ids: ["s-late"],
		byId: { "s-late": row("s-late", { running: true }) },
		phase: "ready",
	});
	list.set({
		ids: ["s-late"],
		byId: { "s-late": row("s-late", { running: false }) },
		phase: "ready",
	});
	await new Promise((resolve) => setTimeout(resolve, 1000));
	assert.equal(app.toasts().length, 1, "running 位先兜底");

	binding.emit({
		type: "turn/end",
		seq: 7,
		time: Date.now(),
		data: { reason: { kind: "completed" } },
	});
	assert.equal(app.toasts().length, 1, "迟到的 turn/end 不应再补一张");
	app.dispose();
}

async function testEventBeforeRunningBit() {
	const list = createList();
	const bindings = new Map();
	const binding = createBinding();
	bindings.set("s4", binding);
	list.set({ ids: ["s4"], byId: { s4: row("s4") }, phase: "ready" });

	const app = mount({ list, bindings });
	list.set({
		ids: ["s4"],
		byId: { s4: row("s4", { running: true }) },
		phase: "ready",
	});
	binding.emit({
		type: "turn/end",
		time: Date.now(),
		data: { reason: { kind: "completed" } },
	});
	list.set({
		ids: ["s4"],
		byId: { s4: row("s4", { running: false }) },
		phase: "ready",
	});
	await new Promise((resolve) => setTimeout(resolve, 1000));
	assert.equal(app.toasts().length, 1, "事件与 running 位只应产生一条通知");
	app.dispose();
}

async function testErrorToast() {
	const list = createList();
	const bindings = new Map();
	const binding = createBinding();
	bindings.set("s5", binding);
	list.set({ ids: ["s5"], byId: { s5: row("s5") }, phase: "ready" });

	const app = mount({ list, bindings });
	binding.emit({
		type: "turn/end",
		time: Date.now(),
		data: { reason: { kind: "error", error: { message: "boom" } } },
	});
	assert.equal(app.toasts().length, 1);
	assert.equal(app.toasts()[0].title, "任务执行失败");
	assert.equal(app.toasts()[0].tone, "error");
	app.dispose();
}

async function testWheelForwarding() {
	const body = sandbox.document.body;
	const scroll = {
		scrollTop: 0,
		scrollLeft: 0,
		clientHeight: 100,
		clientWidth: 100,
		scrollHeight: 500,
		scrollWidth: 100,
		parentElement: body,
	};
	const chat = { parentElement: scroll };
	const card = { contains: (element) => element === card };
	sandbox.document.elementsFromPoint = () => [card, chat, scroll];

	const previousStyle = computedStyle;
	computedStyle = (node) => ({
		overflowY: node === scroll ? "auto" : "hidden",
	});
	try {
		let prevented = false;
		const handled = plugin.__forwardWheel(card, {
			clientX: 10,
			clientY: 10,
			deltaY: 120,
			deltaX: 0,
			deltaMode: 0,
			ctrlKey: false,
			preventDefault() {
				prevented = true;
			},
		});
		assert.equal(handled, true, "卡片上的滚轮应转发给下面的滚动容器");
		assert.equal(scroll.scrollTop, 120);
		assert.equal(prevented, true);

		prevented = false;
		const zoom = plugin.__forwardWheel(card, {
			clientX: 10,
			clientY: 10,
			deltaY: 120,
			deltaX: 0,
			deltaMode: 0,
			ctrlKey: true,
			preventDefault() {
				prevented = true;
			},
		});
		assert.equal(zoom, false, "Ctrl+滚轮是缩放，不能拦");
		assert.equal(scroll.scrollTop, 120);
	} finally {
		computedStyle = previousStyle;
		sandbox.document.elementsFromPoint = () => [];
	}
}

const tests = [
	["completed 通知", testCompletedToast],
	["卡片滚轮转发", testWheelForwarding],
	["渲染出的卡片结构", testRenderedMarkup],
	["查看对话动作", testOpenConversationAction],
	["重复 turn/end 去重", testDuplicateTurnEnd],
	["忽略子代理", testSubagentIgnored],
	["保留后台运行会话", testRetainsBackgroundSession],
	["峰时 token 与花费", testUsagePeakPricing],
	["attempt 用量替换", testUsageAttemptReplacement],
	["空闲时 token 与花费", testUsageIdlePricing],
	["缓存命中价格", testUsageCachePricing],
	["未知模型只显示 token", testUsageUnknownModel],
	["自定义价格覆盖", testPriceOverride],
	["无投影时只统计观察值", testUsageObservedOnly],
	["系统级窗口 POST 路径", testSystemOverlayPath],
	["running 位兜底", testRunningFallback],
	["新一轮取消旧兜底", testNewTurnCancelsFallback],
	["兜底后迟到事件不重复", testLateEventAfterFallback],
	["事件先于 running 位", testEventBeforeRunningBit],
	["error 文案", testErrorToast],
];

let failed = 0;
for (const [name, run] of tests) {
	try {
		await run();
		console.log(`ok - ${name}`);
	} catch (error) {
		failed += 1;
		console.error(`not ok - ${name}`);
		console.error(error);
	}
}

if (failed > 0) process.exitCode = 1;
else console.log(`\n${tests.length} passed`);
