/**
 * 宿主侧集成测试：用 mock ctx 调用 lib/index.js 注册的 HTTP 路由，
 * 验证能力探测、并发 /notify 打开两个窗口、/actions、/dismiss 与清理。
 *
 * 只在 Windows 上跑；会短暂弹出两个原生置顶窗口，然后清理。
 */
import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import plugin from "../lib/index.js";

if (process.platform !== "win32") {
	console.log("skip: Windows only");
	process.exit(0);
}

const TEST_ROOT = mkdtempSync(join(tmpdir(), "dsh-task-toast-test-"));
process.env.DSH_TASK_TOAST_TMP = TEST_ROOT;

const routes = new Map();
const disposers = [];
const ctx = {
	webServer: {
		register({ path, handler }) {
			routes.set(path, handler);
			return () => routes.delete(path);
		},
	},
	connection: { isTrusted: () => true },
	effect(fn) {
		const dispose = fn();
		if (typeof dispose === "function") disposers.push(dispose);
		return dispose;
	},
	get(name) {
		return name === "connection" ? ctx.connection : undefined;
	},
};

function response() {
	let body = "";
	return {
		statusCode: 200,
		writeHead(code) {
			this.statusCode = code;
		},
		end(value) {
			body += value ?? "";
		},
		get body() {
			return body;
		},
		json() {
			return JSON.parse(body || "{}");
		},
	};
}

function request(method, payload) {
	const req = Readable.from(
		payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))],
	);
	req.method = method;
	req.headers = { host: "127.0.0.1:5041", "content-type": "application/json" };
	return req;
}

async function call(path, method, payload) {
	const handler = routes.get(`/dsh-task-toast/api${path}`);
	assert.ok(handler, `route ${path} should exist`);
	const res = response();
	await handler(request(method, payload), res);
	return res;
}

function makePayload(suffix) {
	return {
		id: `host-test-${suffix}-${Date.now()}`,
		sessionId: `session-host-test-${suffix}`,
		title: "任务已完成",
		body: "对话已就绪，可以回来继续查看。",
		sessionTitle: `「宿主侧并发测试 ${suffix}」`,
		detail: `第一行 ${suffix}\n第二行 ${suffix}`,
		tone: "success",
		theme: "light",
		timeLabel: "16:10",
		durationText: "用时 3 秒",
		labels: {
			turn: "本次",
			total: "对话累计",
			open: "查看对话",
			close: "关闭",
		},
		stats: {
			turnTokensText: "1,234 tokens",
			turnCostText: "≈¥0.0042",
			totalTokensText: "5,678 tokens",
			totalCostText: "≈¥0.0193",
		},
		durationMs: 30000,
	};
}

try {
	plugin.apply(ctx);

	const caps = await call("/capabilities", "GET");
	assert.equal(caps.statusCode, 200);
	assert.equal(caps.json().systemOverlay, true);
	console.log("ok - capabilities");

	const firstPayload = makePayload("A");
	delete firstPayload.durationMs;
	const secondPayload = makePayload("B");

	const first = await call("/notify", "POST", firstPayload);
	assert.equal(first.statusCode, 200);
	assert.equal(first.json().ok, true);
	console.log("ok - notify A");

	const second = await call("/notify", "POST", secondPayload);
	assert.equal(second.statusCode, 200);
	assert.equal(second.json().ok, true);
	console.log("ok - notify B");

	const popupDirs = readdirSync(TEST_ROOT).filter((name) =>
		name.startsWith("popup-"),
	);
	assert.ok(popupDirs.length >= 2, "两个并发通知应各有独立窗口目录");

	const popupStates = popupDirs
		.map((name) => join(TEST_ROOT, name, "state.json"))
		.filter((path) => existsSync(path))
		.map((path) => JSON.parse(readFileSync(path, "utf8")));

	const stateA = popupStates.find((state) => state.id === firstPayload.id);
	const stateB = popupStates.find((state) => state.id === secondPayload.id);
	assert.ok(stateA, "第一条通知应有自己的 state.json");
	assert.ok(stateB, "第二条通知应有自己的 state.json");
	assert.equal(stateA.durationMs, 5000);
	assert.equal(stateB.durationMs, 30000);
	assert.equal(stateA.detail, firstPayload.detail);
	assert.equal(stateB.detail, secondPayload.detail);
	console.log("ok - two independent state files");

	const actions = await call("/actions", "GET");
	assert.equal(actions.statusCode, 200);
	assert.ok(Array.isArray(actions.json().actions));
	console.log("ok - actions");

	const dismiss = await call("/dismiss", "POST", {});
	assert.equal(dismiss.statusCode, 200);
	assert.equal(dismiss.json().ok, true);
	console.log("ok - dismiss");
} finally {
	for (const dispose of disposers.splice(0)) dispose();
	try {
		rmSync(TEST_ROOT, { recursive: true, force: true });
	} catch {}
	console.log("ok - cleanup");
}
