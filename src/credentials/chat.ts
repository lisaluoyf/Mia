import type { APIMasterClient, ResolverErrorCode } from "../clients/apimaster.js";
import { ChatCompletionError, ResolverError } from "../clients/apimaster.js";
import { sameModelId } from "../settings/service.js";

type KeyResolutionGuestFallbackReason = Extract<ResolverErrorCode, "telegram_not_bound" | "no_usable_api_key">;
export type GuestFallbackReason = KeyResolutionGuestFallbackReason | "user_request_failed";

export interface ChatCredential {
  apiKey: string;
  model: string;
  source: "user" | "guest";
  fallbackReason: GuestFallbackReason | null;
}

export interface ChatCredentialProvider {
  resolve(telegramUserId: number, requestedModel: string, fallbackUserModel?: string): Promise<ChatCredential>;
  fallbackForTextRequest?(credential: ChatCredential, error: unknown): ChatCredential | null;
}

interface GuestCredentialOptions {
  apiKey: string;
  model: string | (() => string);
}

export class ChatCredentialResolver implements ChatCredentialProvider {
  constructor(
    private readonly client: Pick<APIMasterClient, "resolveAPIKey">,
    private readonly guest: GuestCredentialOptions,
  ) {}

  async resolve(
    telegramUserId: number,
    requestedModel: string,
    fallbackUserModel?: string,
  ): Promise<ChatCredential> {
    try {
      return {
        apiKey: await this.client.resolveAPIKey(telegramUserId, requestedModel),
        model: requestedModel,
        source: "user",
        fallbackReason: null,
      };
    } catch (error) {
      if (!(error instanceof ResolverError) || !isGuestFallback(error.code)) throw error;
      if (error.code === "no_usable_api_key" && fallbackUserModel &&
          !sameModelId(requestedModel, fallbackUserModel)) {
        try {
          return {
            apiKey: await this.client.resolveAPIKey(telegramUserId, fallbackUserModel),
            model: fallbackUserModel,
            source: "user",
            fallbackReason: null,
          };
        } catch (fallbackError) {
          if (!(fallbackError instanceof ResolverError) || !isGuestFallback(fallbackError.code)) {
            throw fallbackError;
          }
          return this.guestCredential(fallbackError.code);
        }
      }
      return this.guestCredential(error.code);
    }
  }

  fallbackForTextRequest(credential: ChatCredential, error: unknown): ChatCredential | null {
    if (credential.source !== "user" || !isGuestTextRequestFallback(error)) return null;
    return this.guestCredential("user_request_failed");
  }

  private guestCredential(fallbackReason: GuestFallbackReason): ChatCredential {
    return {
      apiKey: this.guest.apiKey,
      model: typeof this.guest.model === "function" ? this.guest.model() : this.guest.model,
      source: "guest",
      fallbackReason,
    };
  }
}

export async function withGuestTextRequestFallback<T>(
  credentials: Pick<ChatCredentialProvider, "fallbackForTextRequest"> | undefined,
  credential: ChatCredential,
  request: (current: ChatCredential) => Promise<T>,
): Promise<{ value: T; credential: ChatCredential }> {
  try {
    return { value: await request(credential), credential };
  } catch (error) {
    const fallback = credentials?.fallbackForTextRequest?.(credential, error);
    if (!fallback) throw error;
    return { value: await request(fallback), credential: fallback };
  }
}

function isGuestFallback(code: ResolverErrorCode): code is KeyResolutionGuestFallbackReason {
  return code === "telegram_not_bound" || code === "no_usable_api_key";
}

function isGuestTextRequestFallback(error: unknown): boolean {
  if (error instanceof ChatCompletionError) return !isAccountGovernanceFailure(error.code);
  if (!(error instanceof Error) || error.name !== "AgentModelError") return false;
  const candidate = error as unknown as { code?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  return !isAccountGovernanceFailure(code);
}

function isAccountGovernanceFailure(code: string | undefined): boolean {
  return [
    "user_disabled", "account_disabled", "account_suspended", "risk_denied",
    "risk_blocked", "access_denied", "permission_denied", "policy_violation",
    "content_policy_violation",
  ].includes(code ?? "");
}
