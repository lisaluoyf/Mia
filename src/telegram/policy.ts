interface MessageEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TextMessageInput {
  chatType: string;
  text: string;
  entities?: readonly MessageEntity[] | undefined;
  repliedToUserId?: number | undefined;
}

export interface BotIdentity {
  id: number;
  username: string;
}

function isBotMention(text: string, entity: MessageEntity, username: string): boolean {
  if (entity.type !== "mention") {
    return false;
  }
  const mention = text.slice(entity.offset, entity.offset + entity.length);
  return mention.toLocaleLowerCase() === `@${username.toLocaleLowerCase()}`;
}

export function shouldRespond(input: TextMessageInput, bot: BotIdentity): boolean {
  if (input.chatType === "private") {
    return true;
  }
  if (input.chatType !== "group" && input.chatType !== "supergroup") {
    return false;
  }
  if (input.repliedToUserId === bot.id) {
    return true;
  }
  return (input.entities ?? []).some((entity) => isBotMention(input.text, entity, bot.username));
}

export function promptFromMessage(input: TextMessageInput, bot: BotIdentity): string {
  const mentionEntities = (input.entities ?? [])
    .filter((entity) => isBotMention(input.text, entity, bot.username))
    .sort((a, b) => b.offset - a.offset);

  let prompt = input.text;
  for (const entity of mentionEntities) {
    prompt = `${prompt.slice(0, entity.offset)}${prompt.slice(entity.offset + entity.length)}`;
  }
  return prompt.trim() || "你好";
}
