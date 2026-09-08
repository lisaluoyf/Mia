export interface MiaBotCommand {
  command: string;
  description: string;
}

const COMMANDS = ["tr", "ntr", "image", "video", "sticker", "new"] as const;

const ENGLISH_DESCRIPTIONS: Record<typeof COMMANDS[number], string> = {
  image: "Generate or edit an image",
  video: "Generate a video",
  sticker: "Create a Telegram sticker",
  new: "Start a new conversation",
  tr: "Enter translation mode",
  ntr: "Exit translation mode",
};

const CHINESE_DESCRIPTIONS: Record<typeof COMMANDS[number], string> = {
  image: "生成或编辑图片",
  video: "生成视频",
  sticker: "制作 Telegram 贴纸",
  new: "开始新对话",
  tr: "进入翻译模式",
  ntr: "退出翻译模式",
};

export function botCommands(language?: string | null): MiaBotCommand[] {
  const descriptions = language?.toLowerCase().startsWith("zh")
    ? CHINESE_DESCRIPTIONS
    : ENGLISH_DESCRIPTIONS;
  return COMMANDS.map((command) => ({ command, description: descriptions[command] }));
}
