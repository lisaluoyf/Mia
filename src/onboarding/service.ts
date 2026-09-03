import type { ContextStore } from "../storage/store.js";
import type { OnboardingProfileUpdates, OnboardingState } from "../storage/types.js";

export const ONBOARDING_MAX_TURNS = 100;
export const ONBOARDING_MAX_PROMPTS = 2;
export const ONBOARDING_REPROMPT_INTERVAL = 20;

export type OnboardingMissingField = "preferred_name" | "primary_role" | "primary_goal";

export interface OnboardingEligibility {
  eligible: boolean;
  completedTurns: number;
  currentTurn: number;
  promptCount: number;
  missingFields: OnboardingMissingField[];
  reason: "eligible" | "completed" | "expired" | "prompt_limit" | "interval";
}

type OnboardingStore = Pick<ContextStore,
  "countSuccessfulPrivateTurns" | "getOnboardingState" | "ensureOnboardingState" |
  "expireOnboarding" | "recordOnboardingPrompt" | "applyOnboardingProfileUpdates" |
  "selectOnboardingRole" | "deferOnboarding">;

export function onboardingMissingFields(state: OnboardingState): OnboardingMissingField[] {
  const missing: OnboardingMissingField[] = [];
  if (!state.hasPreferredName) missing.push("preferred_name");
  if (state.selectedRole === null) missing.push("primary_role");
  if (!state.hasPrimaryGoal) missing.push("primary_goal");
  return missing;
}

export class OnboardingService {
  constructor(private readonly store: OnboardingStore) {}

  eligibility(chatId: number, userId: number): OnboardingEligibility {
    const completedTurns = this.store.countSuccessfulPrivateTurns(chatId, userId);
    const currentTurn = completedTurns + 1;
    let state = this.store.getOnboardingState(userId) ?? this.store.ensureOnboardingState(userId);
    if (completedTurns >= ONBOARDING_MAX_TURNS && !state.completedAt && !state.expiredAt) {
      state = this.store.expireOnboarding(userId);
    }
    const missingFields = onboardingMissingFields(state);
    if (state.completedAt || missingFields.length === 0) {
      return { eligible: false, completedTurns, currentTurn, promptCount: state.promptCount, missingFields, reason: "completed" };
    }
    if (state.expiredAt || completedTurns >= ONBOARDING_MAX_TURNS) {
      return { eligible: false, completedTurns, currentTurn, promptCount: state.promptCount, missingFields, reason: "expired" };
    }
    if (state.promptCount >= ONBOARDING_MAX_PROMPTS) {
      return { eligible: false, completedTurns, currentTurn, promptCount: state.promptCount, missingFields, reason: "prompt_limit" };
    }
    if (state.promptCount > 0 && (state.lastPromptTurn === null || currentTurn - state.lastPromptTurn < ONBOARDING_REPROMPT_INTERVAL)) {
      return { eligible: false, completedTurns, currentTurn, promptCount: state.promptCount, missingFields, reason: "interval" };
    }
    return { eligible: true, completedTurns, currentTurn, promptCount: state.promptCount, missingFields, reason: "eligible" };
  }

  applyProfileUpdates(userId: number, messageId: number, updates: OnboardingProfileUpdates) {
    if (!updates.preferredName && !updates.primaryRole && !updates.primaryGoal) return null;
    return this.store.applyOnboardingProfileUpdates({ telegramUserId: userId, sourceMessageId: messageId, updates });
  }

  claimPrompt(userId: number, turn: number): OnboardingState | null {
    return this.store.recordOnboardingPrompt(userId, turn);
  }

  selectRole(userId: number, role: string | null, custom: boolean, sourceMessageId?: number | null) {
    return this.store.selectOnboardingRole({
      telegramUserId: userId,
      role,
      custom,
      ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
    });
  }

  defer(userId: number): OnboardingState {
    return this.store.deferOnboarding(userId);
  }
}
