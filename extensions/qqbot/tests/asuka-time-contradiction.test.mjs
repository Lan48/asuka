import assert from "node:assert/strict";

const {
  buildTimeAwareDeliveryFallback,
  isTimeContradictoryDeliveryText,
} = await import("../dist/src/utils/time-contradiction.js");

const lateNight = Date.UTC(2026, 4, 20, 15, 33, 0); // 23:33 Asia/Shanghai
const lateMorning = Date.UTC(2026, 4, 20, 2, 30, 0); // 10:30 Asia/Shanghai
const evening = Date.UTC(2026, 4, 20, 12, 30, 0); // 20:30 Asia/Shanghai

assert.equal(
  isTimeContradictoryDeliveryText("我起床了，在忙完这阵子后来找你。", "Asia/Shanghai", lateNight),
  true,
  "late-night visible replies should reject stale wake-up/daytime promise text",
);
assert.equal(
  isTimeContradictoryDeliveryText("早安，我刚醒，今天也在。", "Asia/Shanghai", lateNight),
  true,
  "late-night visible replies should reject morning greetings unless explicitly negated",
);
assert.equal(
  isTimeContradictoryDeliveryText("……都到中午了，我也还在这里。", "Asia/Shanghai", lateNight),
  true,
  "late-night visible replies should reject explicit noon wording",
);
assert.equal(
  isTimeContradictoryDeliveryText("下午那阵风还在，我来看看你。", "Asia/Shanghai", lateNight),
  true,
  "late-night visible replies should reject explicit afternoon wording",
);
assert.equal(
  isTimeContradictoryDeliveryText("这个点我不重演刚醒那段了，我在这里。", "Asia/Shanghai", lateNight),
  false,
  "time-aware corrections should not be rejected just because they mention the stale scene",
);
assert.equal(
  isTimeContradictoryDeliveryText("（窝在被子里）你怎么还不睡。", "Asia/Shanghai", lateMorning),
  true,
  "late morning should reject stale bed/wake-up stage directions",
);
assert.equal(
  isTimeContradictoryDeliveryText("早，我刚醒，今天也在。", "Asia/Shanghai", lateMorning, {
    recentContextText: "你（2小时前）: 还在床边吗\n我（1小时前）: ……早上好。我还在。你还在睡，我就先不吵你。",
  }),
  false,
  "late morning should allow morning/bed continuity when recent context explicitly supports it",
);
assert.equal(
  isTimeContradictoryDeliveryText("晚安，关灯睡吧。", "Asia/Shanghai", evening),
  false,
  "evening bedtime language should remain valid outside daytime",
);
assert.equal(
  buildTimeAwareDeliveryFallback("（缩进你怀里）在陪陪我", { forceImage: true }),
  "",
  "forced image fallback should not fabricate a fixed visible image-confirmation reply",
);

console.log("[qqbot:test] asuka time-contradiction fixtures passed");
