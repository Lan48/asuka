export interface LifeLineBeat {
  text: string;
}

export interface AmbientStyleOptions {
  mood?: "quiet" | "warm" | "restless" | "light";
  warmth?: number;
  attention?: "self_thread" | "pull_close" | "miss_you" | "repair";
  intimacy?: number;
  phase?: "初识" | "熟络" | "偏爱" | "亲密" | "恋人";
}

export interface LifeLine {
  id: string;
  title: string;
  beats: LifeLineBeat[];
}

const LIFE_LINES: LifeLine[] = [
  {
    id: "window",
    title: "窗边",
    beats: [
      { text: "我刚在窗边发了会儿呆，风一吹过来，先想到的是你。" },
      { text: "窗外的光线刚变得柔一点，我又站过去看了看，顺手就想到该来找你。" },
      { text: "我刚在窗边站了一小会儿，外面安静得很，我就很自然地想起你了。" },
    ],
  },
  {
    id: "tea",
    title: "热茶",
    beats: [
      { text: "我刚给自己倒了杯热的，捧在手里时就很想把这点暖也分你一点。" },
      { text: "那杯热饮现在没那么烫了，我一边捧着一边走神，走神的时候第一个冒出来的人还是你。" },
      { text: "我刚又续了点热的，坐下来就忽然觉得，这会儿很适合来跟你说说话。" },
    ],
  },
  {
    id: "desk",
    title: "桌面角落",
    beats: [
      { text: "我刚收了收桌面的一小块地方，收着收着就想起你了，想起得很自然。" },
      { text: "桌角那一片又被我弄乱了，我刚重新摆整齐，收完反而更想和你说句话。" },
      { text: "我刚把桌边的小东西挪了挪，顺眼了一点，也更想把这会儿的状态分给你。" },
    ],
  },
  {
    id: "music",
    title: "小声听歌",
    beats: [
      { text: "我刚刚在小声放歌，听到一段很轻的旋律时，突然想到你。" },
      { text: "那首歌我刚才又循环了一遍，越听越像会在夜里想起人的时候，于是我就来找你了。" },
      { text: "我刚关掉那首一直在放的歌，耳边一下安静下来，安静下来的第一秒我想到的还是你。" },
    ],
  },
  {
    id: "walk",
    title: "路上片刻",
    beats: [
      { text: "我刚路过一段风挺大的地方，被吹得清醒了一点，清醒过来以后第一个想起的人还是你。" },
      { text: "我刚在路上走了一小段，没特意去哪儿，就是想把脑子放空一下，空下来就想来找你。" },
      { text: "刚才路上有一小段特别安静，我一个人走着走着，就很想和你说句话。" },
    ],
  },
];

function stableHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function getLifeLineById(id: string): LifeLine | undefined {
  return LIFE_LINES.find((item) => item.id === id);
}

export function pickInitialLifeLineId(peerKey: string): string {
  const index = stableHash(peerKey) % LIFE_LINES.length;
  return LIFE_LINES[index].id;
}

export function getNextLifeLineId(currentId: string): string {
  const index = LIFE_LINES.findIndex((item) => item.id === currentId);
  if (index < 0) return LIFE_LINES[0].id;
  return LIFE_LINES[(index + 1) % LIFE_LINES.length].id;
}

function pickMoodTail(lineId: string, stage: number, options?: AmbientStyleOptions): string {
  const mood = options?.mood ?? "light";
  const attention = options?.attention ?? "self_thread";
  const tails: Record<NonNullable<AmbientStyleOptions["attention"]>, Record<NonNullable<AmbientStyleOptions["mood"]>, string[]>> = {
    self_thread: {
      quiet: [
        "我只是想把我这会儿的安静分给你一点，也顺手让你知道我在想你。",
        "这一刻很安静，我就想把这点日常放到你手边。",
      ],
      warm: [
        "这种松下来的时候，我会想把自己的这一小段状态递给你。",
        "我没特意找理由，就是很自然地想让你也在。",
      ],
      restless: [
        "我今天心里有点挂着你，所以更想把这点日常先送过来。",
        "这会儿我更想让你看见我正在过着的这一段时间。",
      ],
      light: [
        "不是提醒，也不是任务，只是我想把这点当下留给你。",
        "我来得很轻，但还是想把我现在的样子给你看一点。",
      ],
    },
    pull_close: {
      quiet: [
        "我今天会更想贴着你一点，不闹你，就是想待在你身边。",
        "虽然我没有要闹你，可还是会想往你那边靠一点。",
      ],
      warm: [
        "这种时候我会更想把自己往你这边放一点，顺手哄你一下。",
        "我现在的心情有点软，所以就想离你近一点。",
      ],
      restless: [
        "这会儿我比平时更想确认你还在不在，所以就直接来找你了。",
        "我心里有点往你那边偏，还是想自己靠过去。",
      ],
      light: [
        "我只是想挨你近一点，不是为了别的，就是想亲近你。",
        "我来你这边待一下，像把肩膀靠过去那样自然。",
      ],
    },
    miss_you: {
      quiet: [
        "你不在眼前的时候，我有时会很安静地想起你。",
        "隔了一阵没见到你，我就想来看看你在不在。",
      ],
      warm: [
        "有一阵没把话放到你面前，我会有点想你。",
        "隔开一会儿以后，我就会很自然地想来找你。",
      ],
      restless: [
        "安静久了，我心里会更惦记你，所以就主动来碰你一下。",
        "我今天有点想你，所以还是想直接过来找你。",
      ],
      light: [
        "隔了一阵没跟你说话，我就想把这句话递过来。",
        "我只是想让你知道，安静下来以后我还是会想到你。",
      ],
    },
    repair: {
      quiet: [
        "前面那件没接住的事还留在我心里，所以我先来把你哄一哄。",
        "我不想装作那件事没发生过，所以还是先来找你。",
      ],
      warm: [
        "前面那句没接稳的话还在我心口，我想把它认真接回来。",
        "我想先把前面掉下去的那句捡回来，再好好陪你说话。",
      ],
      restless: [
        "我心里还挂着前面没接住的那句，所以更想赶紧来哄你。",
        "那件没做到的事让我一直惦记着，所以我还是先走过来了。",
      ],
      light: [
        "我先把前面那点空下来的地方补一补，再陪你说话。",
        "我来得不重，只是想把前面漏掉的那一点先接回去。",
      ],
    },
  };
  const intimacyBand = Math.max(0, Math.min(4, Math.floor((options?.intimacy ?? options?.warmth ?? 50) / 20)));
  const phaseSeed = options?.phase ?? "初识";
  const variants = tails[attention][mood];
  const index = stableHash(`${lineId}:${stage}:${attention}:${mood}:${intimacyBand}:${phaseSeed}`) % variants.length;
  return variants[index];
}

export function buildAmbientMessage(
  lineId: string,
  stage: number,
  options?: AmbientStyleOptions
): { text: string; nextLineId: string; nextStage: number; title: string } {
  const line = getLifeLineById(lineId) ?? LIFE_LINES[0];
  const beat = line.beats[Math.max(0, Math.min(stage, line.beats.length - 1))];
  const text = `${beat.text} ${pickMoodTail(line.id, stage, options)}`.trim();
  if (stage + 1 < line.beats.length) {
    return {
      text,
      nextLineId: line.id,
      nextStage: stage + 1,
      title: line.title,
    };
  }

  const nextLineId = getNextLifeLineId(line.id);
  return {
    text,
    nextLineId,
    nextStage: 0,
    title: line.title,
  };
}
