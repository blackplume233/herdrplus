import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 生成 herdr 配置文件：内嵌终端里只留终端内容 —— 导航交给 VSCode 侧栏，分栏交给 VSCode 的 tab/split。
 *
 * herdr 没有启动期开关，只能靠 `[ui]` 配置：
 *   sidebar_start_collapsed = true     # 启动即收起 sidecar
 *   sidebar_collapsed_mode = "hidden"  # 收起即零宽（compact 会留一条窄状态轨）
 *   hide_tab_bar_when_single_tab = true# 单 tab 不画 tab 行
 *   pane_outer_borders = false         # 不画 pane 外框（单 pane 时就是纯终端）
 * 通过 HERDR_CONFIG_PATH 指向生成文件生效——因此这里需要把用户原配置一起带过去（该变量是覆盖而非叠加）。
 */

const OVERRIDES: Record<string, string[]> = {
  '[ui]': [
    'sidebar_start_collapsed = true',
    'sidebar_collapsed_mode = "hidden"',
    'hide_tab_bar_when_single_tab = true',
    'pane_outer_borders = false',
  ],
  // 扩展拉起的终端本身可能就在 herdr pane 里（在 herdr 里开 VS Code）——不放开这条，
  // herdr 会以 "nested herdr is disabled by default" 立刻退出，终端开完即消失。
  '[experimental]': ['allow_nested = true'],
};
const GENERATED_HEADER = '# 由 HerdrPlus 生成：内嵌终端只显示终端内容（无 herdr 侧栏/tab 行/外框）。原配置内容见下方。\n';

export function userConfigPath(): string {
  if (process.env.HERDR_CONFIG_PATH?.trim()) {
    return process.env.HERDR_CONFIG_PATH.trim();
  }
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'herdr', 'config.toml');
}

/** 把覆盖键写入文本（存在则替换，不存在则插入；缺段则追加到末尾）。 */
export function mergeOverrides(source: string): string {
  let lines = source.length > 0 ? source.split(/\r?\n/) : [];

  for (const [section, keys] of Object.entries(OVERRIDES)) {
    const start = lines.findIndex((line) => line.trim() === section);
    if (start < 0) {
      const body = lines.join('\n').replace(/\s*$/, '');
      lines = [...lines, ...(body ? [''] : []), section, ...keys];
      continue;
    }

    let end = lines.length;
    for (let index = start + 1; index < lines.length; index++) {
      if (/^\s*\[/.test(lines[index])) {
        end = index;
        break;
      }
    }

    const present = new Set(
      lines
        .slice(start + 1, end)
        .map((line) => line.split('=')[0]?.trim())
        .filter((key): key is string => Boolean(key)),
    );
    const missing = keys.filter((key) => !present.has(key.split('=')[0].trim()));
    const patched = lines.slice(start + 1, end).map((line) => {
      const key = line.split('=')[0]?.trim();
      return keys.find((candidate) => candidate.split('=')[0].trim() === key) ?? line;
    });
    lines = [...lines.slice(0, start + 1), ...patched, ...missing, ...lines.slice(end)];
  }

  return `${GENERATED_HEADER}${lines.join('\n').replace(/\s*$/, '')}\n`;
}

/** 写出生效配置，返回应设置给终端的 HERDR_CONFIG_PATH（失败返回 undefined，终端照常可跑）。 */
export function writeEffectiveConfig(storageDir: string, bareTui: boolean): string | undefined {
  if (!bareTui) {
    return undefined;
  }
  try {
    const source = fs.existsSync(userConfigPath()) ? fs.readFileSync(userConfigPath(), 'utf8') : '';
    const merged = mergeOverrides(source);
    fs.mkdirSync(storageDir, { recursive: true });
    const target = path.join(storageDir, 'herdr-config.toml');
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== merged) {
      fs.writeFileSync(target, merged, 'utf8');
    }
    return target;
  } catch {
    return undefined;
  }
}
