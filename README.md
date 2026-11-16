# markdown-render-speed-02-v2

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/seannbeez/markdown-render-speed-02-v2/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/seannbeez/markdown-render-speed-02-v2/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free CommonMark 0.31.2 + GFM 0.29 renderer that returns byte-for-byte the HTML marked 18.1.3 returns. `parse.js` is a single-pass ES module; `main.ts` renders every case in `/input/cases.json` and writes the HTML to `/output/html.json`.

## Run it

```sh
node main.ts
```

## Verification

Verified locally: 720/720 practice cases byte-for-byte against marked 18.1.3 (680 CommonMark spec examples + 40 generated READMEs).

---

<sub>Entered on [make.fun](https://make.fun/?ref=ebv85brk&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
