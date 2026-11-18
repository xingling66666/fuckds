import path from 'node:path';
import os from 'node:os';

import { loadConfig } from '../../src/config.mjs';

/** 测试用配置：临时 dataDir + 指定 engine（默认 http，已无 browser） */
export function makeConfig(overrides = {}) {
  const dataDir = overrides.dataDir || path.join(os.tmpdir(), `fuckds-test-${Math.random().toString(36).slice(2, 8)}`);
  return loadConfig(
    {
      DATA_DIR: dataDir,
      DEEPSEEK_USER_TOKEN: 'test-token-0123456789',
      // 测试断言的是旧版 ## 段落格式，这里固定 legacy（生产默认 stealth）
      PROMPT_STYLE: 'legacy',
      // 正文转图片要真起 Chromium 截图，单测里默认关掉（专门测那条通道的用例自己打开）
      PROMPT_AS_ATTACHMENT: 'false',
      ...overrides,
    },
    { store: false },
  );
}
