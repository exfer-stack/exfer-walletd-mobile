// Lightweight i18n — no dependency, just a flat dictionary + a `t()` helper.
// English is the source/default; Chinese is hand-tuned for clarity (plain,
// natural language, not literal). Brand tokens (exfer, EXFER, .vault,
// wallet.key, CSV/JSON) stay as-is. Interpolate with {name} placeholders.

import { createContext, useContext, type ReactNode } from "react";

export type Lang = "en" | "zh";
export const LANGS: { key: Lang; label: string }[] = [
  { key: "en", label: "EN" },
  { key: "zh", label: "中文" },
];

const LS_KEY = "exfer-mobile-lang";
export function readLang(): Lang {
  try {
    return localStorage.getItem(LS_KEY) === "zh" ? "zh" : "en";
  } catch {
    return "en";
  }
}
export function persistLang(l: Lang) {
  try {
    localStorage.setItem(LS_KEY, l);
  } catch {
    /* ignore */
  }
}

const EN = {
  // nav / common
  "nav.wallet": "Wallet",
  "nav.activity": "Activity",
  "nav.settings": "Settings",

  // welcome
  "welcome.h1a": "Transfers that",
  "welcome.h1b": "arrive instantly.",
  "welcome.lede":
    "A fast, lightweight wallet for the Exfer blockchain. Funds show up the moment they hit the network — no waiting, no server, no account.",
  "welcome.instant.t": "Instant",
  "welcome.instant.b":
    "Incoming EXFER shows up in your balance the moment it's sent — no waiting for it to confirm.",
  "welcome.light.t": "Lightweight",
  "welcome.light.b":
    "The wallet engine runs on your phone. Nothing to install, nothing in the background.",
  "welcome.yours.t": "Yours",
  "welcome.yours.b": "Keys are generated on the device and never leave it.",
  "welcome.cta": "Get started",
  "welcome.hint": "Set a password next, or restore from a backup.",

  // onboarding
  "ob.new": "New wallet",
  "ob.restore": "Restore",
  "ob.createTitle": "Set up your wallet",
  "ob.restoreTitle": "Restore your wallet",
  "ob.createSub":
    "Choose a password to encrypt your keys at rest. It's saved in your device keychain — you enter it once.",
  "ob.restoreSub":
    "Restore every address from an encrypted .vault backup file and a new local password.",
  "ob.restoreBanner":
    "Set a new local password and your backup's password below, then tap Restore to choose your .vault file.",
  "ob.password": "Password",
  "ob.newLocalPassword": "New local password",
  "ob.passwordHelp": "At least 8 characters. Mix letters, numbers & symbols.",
  "ob.confirm": "Confirm password",
  "ob.backupPassword": "Backup password",
  "ob.backupPasswordHelp": "The password the .vault backup was created with.",
  "ob.warnTitle": "Back this up.",
  "ob.warnBody":
    "Your password unlocks and encrypts every key. Forget it and there's no way back in — after setup, save an encrypted backup from Settings → Back up wallet.",
  "ob.create": "Create wallet",
  "ob.creating": "Creating…",
  "ob.chooseRestore": "Choose file & restore",
  "ob.restoring": "Restoring…",
  "ob.errMin": "Password must be at least 8 characters.",
  "ob.errMismatch": "Passwords do not match.",
  "ob.errBackupPw": "Enter the backup password.",
  "ob.errNoFile":
    'No .vault file selected. Tap "Choose file & restore" and pick your backup.',
  "ob.toastReady": "Wallet ready",
  "ob.toastReadyBody": "Welcome to exfer.",
  "ob.toastRestored": "Wallet restored",
  "ob.toastRestoredBack": "Backup restored — welcome back.",
  "ob.toastRestoredN": "Restored {n} address(es).",

  // home
  "home.totalBalance": "Total balance",
  "home.receive": "Receive",
  "home.send": "Send",
  "home.addresses": "Addresses",
  "home.newAddress": "New address",
  "home.noAddrTitle": "No addresses yet",
  "home.noAddrBody": "Mint your first address to receive EXFER.",
  "home.genAddr": "Generate address",
  "home.showHidden": "Show {n} hidden",
  "home.hideHidden": "Hide {n} hidden",
  "home.capNote":
    "You've reached the {max}-address limit. One address can take any number of deposits.",
  "home.netErrTitle": "Can't reach the network",
  "home.netErrBody":
    "Couldn't load your balance. Check your connection and try again.",
  "home.retry": "Retry",
  "home.capToastTitle": "Address limit reached",
  "home.capToastBody": "This wallet is capped at {max} addresses.",

  // settings
  "set.title": "Settings",
  "set.subtitle": "Node, backup & local data",
  "set.secAppearance": "Appearance",
  "set.secSecurity": "Security",
  "set.secNetwork": "Network",
  "set.secBackup": "Back up & restore",
  "set.secData": "Export & import data",
  "set.secDaemon": "Daemon status",
  "set.secDanger": "Danger zone",
  "set.theme": "Theme",
  "set.dark": "Dark",
  "set.light": "Light",
  "set.accent": "Accent",
  "set.language": "Language",
  "set.hideBalances": "Hide balances",
  "set.hideBalancesSub": "Mask amounts with ••••",
  "set.bioUnlock": "Unlock with Face ID / fingerprint",
  "set.bioUnlockSub": "Require biometrics each time the app opens",
  "set.upstreamNode": "Upstream node",
  "set.indexer": "Indexer",
  "set.indexerDefault": "Default (bundled)",
  "set.backupWallet": "Back up wallet",
  "set.backupWalletSub": "Save all keys to one encrypted .vault",
  "set.restoreBackup": "Restore from backup",
  "set.restoreBackupSub": "Load addresses from a .vault file",
  "set.exportCsv": "Export addresses (CSV)",
  "set.exportLabels": "Export labels (JSON)",
  "set.importKey": "Import wallet.key…",
  "set.importKeySub": "Add an externally-held address",
  "set.dVersion": "Version",
  "set.dNode": "Node",
  "set.dReachable": "Reachable",
  "set.dBlockHeight": "Block height",
  "set.dUpstream": "Upstream",
  "set.dWallets": "Wallets",
  "set.dInflight": "In-flight transfers",
  "set.online": "Online",
  "set.offline": "Offline",
  "set.checking": "Checking…",
  "set.resetWallet": "Reset wallet",
  "set.resetWalletBody":
    "Erases this wallet from this device. Coins stay on-chain, but without a backup you can't get back in.",
  "set.resetWalletCta": "Reset wallet…",
  "set.footer": "exfer wallet · mobile",
} as const;

export type MsgKey = keyof typeof EN;

const ZH: Record<MsgKey, string> = {
  "nav.wallet": "钱包",
  "nav.activity": "动态",
  "nav.settings": "设置",

  "welcome.h1a": "转账",
  "welcome.h1b": "即刻到账。",
  "welcome.lede":
    "极快、极轻的 Exfer 区块链钱包。钱一到立刻显示——不用等、不用服务器、不用注册账号。",
  "welcome.instant.t": "即时到账",
  "welcome.instant.b": "别人转来的 EXFER 一发出，余额里立刻就能看到，不用等确认。",
  "welcome.light.t": "极致轻量",
  "welcome.light.b": "钱包引擎就在手机里运行，无需额外安装，也不在后台常驻。",
  "welcome.yours.t": "完全自持",
  "welcome.yours.b": "私钥在本机生成，永不离开你的设备。",
  "welcome.cta": "开始使用",
  "welcome.hint": "下一步设置密码，或从备份恢复。",

  "ob.new": "新建钱包",
  "ob.restore": "恢复",
  "ob.createTitle": "创建你的钱包",
  "ob.restoreTitle": "恢复你的钱包",
  "ob.createSub": "设置一个密码来加密你的私钥。密码会存进手机的安全钥匙串，只需输入这一次。",
  "ob.restoreSub": "用加密的 .vault 备份文件和一个新的本地密码，恢复你所有的地址。",
  "ob.restoreBanner": "在下方设置新的本地密码和备份密码，然后点「恢复」选择你的 .vault 文件。",
  "ob.password": "密码",
  "ob.newLocalPassword": "新的本地密码",
  "ob.passwordHelp": "至少 8 位，建议混合字母、数字和符号。",
  "ob.confirm": "确认密码",
  "ob.backupPassword": "备份密码",
  "ob.backupPasswordHelp": "创建该 .vault 备份时使用的密码。",
  "ob.warnTitle": "务必备份。",
  "ob.warnBody":
    "密码用来解锁并加密你的每一把私钥。一旦忘记就再也进不来——创建完成后，请到「设置 → 备份钱包」保存一份加密备份。",
  "ob.create": "创建钱包",
  "ob.creating": "创建中…",
  "ob.chooseRestore": "选择文件并恢复",
  "ob.restoring": "恢复中…",
  "ob.errMin": "密码至少 8 位。",
  "ob.errMismatch": "两次输入的密码不一致。",
  "ob.errBackupPw": "请输入备份密码。",
  "ob.errNoFile": "还没有选择 .vault 文件。请点「选择文件并恢复」并选中你的备份。",
  "ob.toastReady": "钱包已就绪",
  "ob.toastReadyBody": "欢迎使用 exfer。",
  "ob.toastRestored": "钱包已恢复",
  "ob.toastRestoredBack": "备份已恢复，欢迎回来。",
  "ob.toastRestoredN": "已恢复 {n} 个地址。",

  "home.totalBalance": "总余额",
  "home.receive": "收款",
  "home.send": "发送",
  "home.addresses": "地址",
  "home.newAddress": "新建地址",
  "home.noAddrTitle": "还没有地址",
  "home.noAddrBody": "创建第一个地址来接收 EXFER。",
  "home.genAddr": "生成地址",
  "home.showHidden": "显示 {n} 个隐藏地址",
  "home.hideHidden": "收起 {n} 个隐藏地址",
  "home.capNote": "已达到 {max} 个地址上限。一个地址可以接收任意多笔转入。",
  "home.netErrTitle": "连不上网络",
  "home.netErrBody": "无法加载余额，请检查网络后重试。",
  "home.retry": "重试",
  "home.capToastTitle": "地址数量已达上限",
  "home.capToastBody": "本钱包最多 {max} 个地址。",

  "set.title": "设置",
  "set.subtitle": "节点、备份与本地数据",
  "set.secAppearance": "外观",
  "set.secSecurity": "安全",
  "set.secNetwork": "网络",
  "set.secBackup": "备份与恢复",
  "set.secData": "导出与导入数据",
  "set.secDaemon": "节点服务状态",
  "set.secDanger": "危险操作",
  "set.theme": "主题",
  "set.dark": "深色",
  "set.light": "浅色",
  "set.accent": "强调色",
  "set.language": "语言",
  "set.hideBalances": "隐藏余额",
  "set.hideBalancesSub": "用 •••• 遮住金额",
  "set.bioUnlock": "用 Face ID / 指纹解锁",
  "set.bioUnlockSub": "每次打开应用都需要生物识别",
  "set.upstreamNode": "上游节点",
  "set.indexer": "索引器",
  "set.indexerDefault": "默认（内置）",
  "set.backupWallet": "备份钱包",
  "set.backupWalletSub": "把所有私钥打包进一个加密的 .vault 文件",
  "set.restoreBackup": "从备份恢复",
  "set.restoreBackupSub": "从 .vault 文件加载地址",
  "set.exportCsv": "导出地址（CSV）",
  "set.exportLabels": "导出标签（JSON）",
  "set.importKey": "导入 wallet.key…",
  "set.importKeySub": "添加一个外部持有的地址",
  "set.dVersion": "版本",
  "set.dNode": "节点",
  "set.dReachable": "可达",
  "set.dBlockHeight": "区块高度",
  "set.dUpstream": "上游",
  "set.dWallets": "钱包数",
  "set.dInflight": "进行中的转账",
  "set.online": "在线",
  "set.offline": "离线",
  "set.checking": "检测中…",
  "set.resetWallet": "重置钱包",
  "set.resetWalletBody": "从本设备抹除此钱包。币仍留在链上，但没有备份你将无法再进入。",
  "set.resetWalletCta": "重置钱包…",
  "set.footer": "exfer wallet · 手机版",
};

const DICT: Record<Lang, Record<MsgKey, string>> = { en: EN, zh: ZH };

type Vars = Record<string, string | number>;
function interpolate(s: string, vars?: Vars): string {
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? "")) : s;
}

interface I18n {
  lang: Lang;
  t: (key: MsgKey, vars?: Vars) => string;
}

const I18nCtx = createContext<I18n>({
  lang: "en",
  t: (key) => EN[key],
});

export function I18nProvider({
  lang,
  children,
}: {
  lang: Lang;
  children: ReactNode;
}) {
  const table = DICT[lang] ?? EN;
  const t = (key: MsgKey, vars?: Vars) =>
    interpolate(table[key] ?? EN[key], vars);
  return <I18nCtx.Provider value={{ lang, t }}>{children}</I18nCtx.Provider>;
}

export function useT(): I18n {
  return useContext(I18nCtx);
}
