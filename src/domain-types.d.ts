import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";

export type HttpRequest = IncomingMessage;
export type HttpResponse = ServerResponse<IncomingMessage>;
export type HttpHeaders = OutgoingHttpHeaders;
export type JsonObject = Record<string, unknown>;
export type FetchLike = typeof globalThis.fetch;

export interface PaymentPrice {
  amount: string;
  currency: string;
  interval: "month";
  frequency: 1;
}

export interface PaymentConfig {
  readonly environment: "live" | "sandbox";
  readonly productId: string;
  readonly priceId: string;
  readonly legacyRecurringPriceIds: readonly string[];
  readonly clientToken: string;
  readonly price: PaymentPrice;
  readonly requestedEnabled: boolean;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly missing: string[];
}

export interface PublicPaymentConfig {
  environment: "live" | "sandbox";
  enabled: boolean;
  configured: boolean;
  productId: string;
  priceId: string;
  clientToken: string;
  price: PaymentPrice;
}

export interface PaddleSecrets {
  apiKey: string;
  webhookSecret: string;
  apiBase: string;
}

export interface PaddlePriceData {
  id?: unknown;
  product_id?: unknown;
  billing_cycle?: { interval?: unknown; frequency?: unknown } | null;
  unit_price?: { amount?: unknown; currency_code?: unknown } | null;
}

export interface PaddleItemData {
  quantity?: unknown;
  price?: PaddlePriceData | null;
}

export interface PaddleCustomData {
  strata_user_id?: unknown;
  strata_checkout_id?: unknown;
  strata_version?: unknown;
}

export interface PaddlePaymentTerms {
  interval?: unknown;
  frequency?: unknown;
}

export interface PaddleBillingDetails {
  enable_checkout?: unknown;
  payment_terms?: PaddlePaymentTerms | null;
}

export interface PaddleCheckoutData {
  url?: unknown;
}

export interface PaddleTransactionData {
  id?: unknown;
  status?: unknown;
  origin?: unknown;
  subscription_id?: unknown;
  collection_mode?: unknown;
  custom_data?: PaddleCustomData | null;
  items?: PaddleItemData[];
  created_at?: unknown;
  updated_at?: unknown;
  customer_id?: unknown;
  transaction_id?: unknown;
  scheduled_change?: PaddleScheduledChange | null;
  current_billing_period?: PaddleBillingPeriod | null;
  billing_cycle?: { interval?: unknown; frequency?: unknown } | null;
  billing_details?: PaddleBillingDetails | null;
  checkout?: PaddleCheckoutData | null;
}

export interface PaddleAdjustmentData {
  id?: unknown;
  status?: unknown;
  type?: unknown;
  action?: unknown;
  transaction_id?: unknown;
}

export interface CheckoutIdentity {
  userId?: unknown;
  checkoutId?: unknown;
  priceId?: unknown;
  productId?: unknown;
  retiredOneTimeCancellation?: boolean;
}

export interface CheckoutRecoveryIdentity extends CheckoutIdentity {
  createdAt?: unknown;
  retirement?: boolean;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };
export interface PaddleTransactionResult {
  transactionId: string;
  status: string;
  data?: PaddleTransactionData;
}

export interface PaddleFetchedTransactionResult extends PaddleTransactionResult {
  data: PaddleTransactionData;
}

export interface PaddleScheduledChange {
  action?: unknown;
  effective_at?: unknown;
}

export interface PaddleBillingPeriod {
  starts_at?: unknown;
  ends_at?: unknown;
}

export interface PaddleSubscriptionItemData extends PaddleItemData {
  recurring?: unknown;
}

export interface PaddleSubscriptionData extends PaddleTransactionData {
  items?: PaddleSubscriptionItemData[];
}

export type SubscriptionValidationResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      entitled: boolean;
      subscriptionId: string;
      customerId: string;
      status: SubscriptionStatus;
      priceId: string;
      productId: string;
      scheduledChangeAction: ScheduledSubscriptionAction | null;
      scheduledChangeAt: number | null;
      currentPeriodEndsAt: number | null;
    };

export interface PaddlePortalSessionData {
  customer_id?: unknown;
  urls?: {
    general?: { overview?: unknown };
    subscriptions?: Array<{
      id?: unknown;
      cancel_subscription?: unknown;
      update_subscription_payment_method?: unknown;
    }>;
  };
}

export interface PaddlePortalLinks {
  overviewUrl: string;
  cancelUrl: string;
  updatePaymentMethodUrl: string;
}

export interface PaddlePortalIdentity {
  customerId: unknown;
  subscriptionId: unknown;
}

export interface SubscriptionValidationIdentity {
  userId?: unknown;
  transactionId?: unknown;
  requireTransaction?: boolean;
}

export type SubscriptionStatus = "active" | "trialing" | "past_due" | "paused" | "canceled";
export type ScheduledSubscriptionAction = "cancel" | "pause" | "resume";

export interface AdminControlsRow {
  user_id: string;
  grant_starts_at: number | null;
  grant_expires_at: number | null;
  grant_revoked_at: number | null;
  checkout_blocked_at: number | null;
  revision: number;
  updated_at: number;
}

export interface DiscoveryAccessSummary {
  active: boolean;
  purchaseCount: number;
  activePurchaseCount: number;
  pendingPurchaseCount: number;
  latestActivePurchaseAt: number | null;
  latestCompletedAt: number | null;
  latestRevokedAt: number | null;
}

export interface CheckoutClaimRow {
  user_id: string;
  price_id: string;
  claim_id: string;
  transaction_id: string | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

export interface PurchaseRow {
  transaction_id: string;
  user_id: string;
  price_id: string;
  product_id: string;
  customer_id: string | null;
  subscription_id: string | null;
  paddle_status: string;
  completed_at: number | null;
  access_revoked_at: number | null;
  revocation_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface SubscriptionRow {
  subscription_id: string;
  user_id: string;
  transaction_id: string;
  customer_id: string;
  status: SubscriptionStatus;
  price_id: string;
  product_id: string;
  scheduled_change_action: ScheduledSubscriptionAction | null;
  scheduled_change_at: number | null;
  current_period_ends_at: number | null;
  event_occurred_at: number;
  created_at: number;
  updated_at: number;
}

export interface SubscriptionWrite {
  subscriptionId: string;
  userId: string;
  customerId: string;
  status: SubscriptionStatus;
  priceId: string;
  productId: string;
  scheduledChangeAction: ScheduledSubscriptionAction | null;
  scheduledChangeAt: number | null;
  currentPeriodEndsAt: number | null;
  eventOccurredAt: number;
  updatedAt: number;
}

export interface SubscriptionCreate extends SubscriptionWrite {
  transactionId: string;
  createdAt: number;
}

export interface PendingPurchaseWrite {
  transactionId: string;
  userId: string;
  priceId: string;
  productId: string;
  paddleStatus: string;
  createdAt: number;
  updatedAt: number;
}

export interface CheckoutClaimWrite {
  userId: string;
  priceId: string;
  claimId: string;
  expiresAt: number;
  now: number;
}

export interface PurchaseCompletion {
  customerId: string | null;
  subscriptionId?: string | null;
  completedAt: number;
  updatedAt: number;
}

export interface AdjustmentWrite {
  adjustmentId: string;
  transactionId: string;
  action: string;
  type: string;
  status: string;
  occurredAt: number;
  updatedAt: number;
}

export interface WebhookEventWrite {
  eventId: string;
  notificationId: string | null;
  eventType: string;
  occurredAt: number;
  processedAt: number;
}

export interface BillingWebhookEvent {
  event_id?: unknown;
  event_type?: unknown;
  occurred_at?: unknown;
  notification_id?: unknown;
  data?: PaddleSubscriptionData & PaddleAdjustmentData;
}

export interface SubscriptionSummary {
  id: string;
  status: SubscriptionStatus;
  active: boolean;
  pastDue: boolean;
  scheduledChange: { action: ScheduledSubscriptionAction; effectiveAt: number | null } | null;
  currentPeriodEndsAt: number | null;
}

export type CheckoutRecovery =
  | { state: "waiting" | "replace" | "entitled" | "deletion" | "blocked" | "pending" }
  | { state: "transaction"; transactionId: string };

export interface BillingStore {
  adminControls(userId: string): Promise<AdminControlsRow | null>;
  hasActiveAppleSubscription(
    userId: string,
    now: number,
    sandbox?: AppleSandboxPolicy,
  ): Promise<boolean>;
  appleSubscriptionsForUser(userId: string): Promise<AppleSubscriptionRow[]>;
  hasPaidDiscoveryAccess(userId: string, priceId?: string | null, now?: number): Promise<boolean>;
  hasCurrentPaidDiscoveryAccess(
    userId: string,
    priceId: string,
    productId: string,
    now?: number,
  ): Promise<boolean>;
  hasEntitledPaidDiscoveryAccess(
    userId: string,
    priceIds: readonly string[],
    productId: string,
    now?: number,
  ): Promise<boolean>;
  currentDiscoveryAccessSummary(
    userId: string,
    priceId: string,
    productId: string,
    now?: number,
  ): Promise<DiscoveryAccessSummary>;
  entitledDiscoveryAccessSummary(
    userId: string,
    priceIds: readonly string[],
    productId: string,
    now?: number,
  ): Promise<DiscoveryAccessSummary>;
  activeAccountDeletion(userId: string, now: number): Promise<JsonObject | null>;
  checkoutCreationForUser(userId: string): Promise<CheckoutClaimRow | null>;
  claimCheckoutCreation(claim: CheckoutClaimWrite): Promise<CheckoutClaimRow | null>;
  recordCheckoutCreationTransaction(
    userId: string,
    claimId: string,
    transactionId: string,
    updatedAt: number,
  ): Promise<CheckoutClaimRow | null>;
  extendCheckoutCreation(
    userId: string,
    claimId: string,
    expiresAt: number,
    updatedAt: number,
  ): Promise<CheckoutClaimRow | null>;
  releaseCheckoutCreation(
    userId: string,
    claimId: string,
    expectedTransactionId?: string | null,
  ): Promise<boolean>;
  purchaseByTransaction(transactionId: string): Promise<PurchaseRow | null>;
  pendingPurchaseForUser(userId: string, priceId: string): Promise<PurchaseRow | null>;
  pendingPurchasesForUser(userId: string): Promise<number>;
  unsettledPurchasesForUser(userId: string): Promise<PurchaseRow[]>;
  insertPendingPurchase(purchase: PendingPurchaseWrite): Promise<PurchaseRow | null>;
  recordClaimedPurchase(
    purchase: PendingPurchaseWrite,
    claimId: string,
  ): Promise<PurchaseRow | null>;
  replacePendingPurchaseCatalog(
    purchase: PurchaseRow,
    replacement: { priceId: string; productId: string; paddleStatus: string; updatedAt: number },
  ): Promise<PurchaseRow | null>;
  completePurchaseCatalogMigration(
    purchase: PurchaseRow,
    replacement: {
      priceId: string;
      productId: string;
      customerId: string | null;
      subscriptionId: string;
      completedAt: number;
      updatedAt: number;
    },
  ): Promise<PurchaseRow | null>;
  completePurchase(
    transactionId: string,
    completion: PurchaseCompletion,
  ): Promise<PurchaseRow | null>;
  updatePurchaseStatus(
    transactionId: string,
    status: string,
    occurredAt: number,
  ): Promise<PurchaseRow | null>;
  createPaddleSubscription(subscription: SubscriptionCreate): Promise<SubscriptionRow | null>;
  updatePaddleSubscription(subscription: SubscriptionWrite): Promise<SubscriptionRow | null>;
  updatePaddleSubscriptionCatalog(
    existing: SubscriptionRow,
    purchase: PurchaseRow,
    subscription: SubscriptionWrite,
  ): Promise<SubscriptionRow | null>;
  subscriptionById(subscriptionId: string): Promise<SubscriptionRow | null>;
  subscriptionForUser(userId: string): Promise<SubscriptionRow | null>;
  webhookEvent(eventId: string): Promise<JsonObject | null>;
  recordWebhookEvent(event: WebhookEventWrite): Promise<boolean>;
  upsertAdjustment(adjustment: AdjustmentWrite): Promise<boolean>;
  adjustmentById(adjustmentId: string): Promise<JsonObject | null>;
  revokePurchase(
    transactionId: string,
    reason: string,
    revokedAt: number,
    updatedAt: number,
  ): Promise<PurchaseRow | null>;
}

export type BillingAdapterMethods = Omit<
  BillingStore,
  | "activeAccountDeletion"
  | "adminControls"
  | "hasActiveAppleSubscription"
  | "appleSubscriptionsForUser"
> & {
  hasDiscoveryAccess(userId: string, priceId?: string | null, now?: number): Promise<boolean>;
  discoveryAccessSummary(
    userId: string,
    priceId?: string | null,
    now?: number,
  ): Promise<DiscoveryAccessSummary>;
};

export interface OperationalLogger {
  debug(event: string, fields?: JsonObject): void;
  info(event: string, fields?: JsonObject): void;
  warn(event: string, fields?: JsonObject): void;
  error(event: string, fields?: JsonObject): void;
}

export interface BillingServiceDependencies {
  store: BillingStore;
  paymentConfig: PaymentConfig;
  enforcePaddleIps: boolean;
  requestAddress: (request: HttpRequest) => string;
  rateAllowed: (
    request: HttpRequest,
    key: string,
    limit: number,
    windowMs?: number,
  ) => boolean | Promise<boolean>;
  isUniqueViolation: (error: unknown) => boolean;
  getAuth: () => AuthService | undefined;
  getUserPayload: (account: SessionRow) => Promise<JsonObject>;
  http: JsonHttpHelpers;
  logger: OperationalLogger;
  /** Which Apple Sandbox purchases unlock Strata+; production-only when left out. */
  appleSandbox?: AppleSandboxPolicy;
  now?: () => number;
  makeId?: () => string;
}

export interface BillingService {
  handleApi(request: HttpRequest, response: HttpResponse, url: URL): Promise<boolean>;
  handleWebhook(request: HttpRequest, response: HttpResponse): Promise<void>;
  hasCurrentAccess(userId: string, now?: number): Promise<boolean>;
  accessSummaryForUser(userId: string): Promise<DiscoveryAccessSummary>;
  subscriptionForUser(userId: string): Promise<SubscriptionSummary | null>;
  reconcileCheckoutCreationBeforeDeletion(
    userId: string,
    expectedClaimId?: string,
  ): Promise<number>;
  reconcileUnsettledPurchases(
    userId: string,
    options?: {
      reuseDraft?: boolean;
      includeFresh?: boolean;
      checkSubscription?: boolean;
      transactionIds?: string[];
    },
  ): Promise<number>;
  warmProviderTrust(): Promise<void>;
}

export type StoreMethod = (...args: any[]) => any;
export type StoreMethods = Record<string, StoreMethod>;

export type AsyncStoreMethod = (...args: any[]) => Promise<any>;
export type StoreCapabilities<Names extends string> = Record<Names, AsyncStoreMethod>;

export type AuthStoreMethod =
  | "accountActionByTokenHash"
  | "activateAccountAction"
  | "adminPrincipal"
  | "cancelAccountDeletion"
  | "claimAccountActionSend"
  | "claimVerificationAttempt"
  | "claimVerificationSend"
  | "completeLoginVerification"
  | "completePasswordReset"
  | "completeSignup"
  | "consumeVerification"
  | "countVerificationSends"
  | "deleteAccount"
  | "deleteAccountForUser"
  | "accountCredentialsById"
  | "deleteOldAccountActionData"
  | "deleteOldVerificationData"
  | "accountExport"
  | "accountSessions"
  | "deleteSession"
  | "discardStagedAccountAction"
  | "insertSession"
  | "insertUser"
  | "insertVerification"
  | "markVerificationDelivery"
  | "rotateVerification"
  | "session"
  | "stageAccountAction"
  | "userByEmail"
  | "userById"
  | "verificationByTokenHash"
  | "verificationSendByChallengeGeneration"
  | "revokeAccountSession"
  | "revokeOtherAccountSessions"
  | "renewSession";

export type AdminStoreMethod =
  | "accountCredentialsById"
  | "adminAudit"
  | "adminOverview"
  | "adminPrincipal"
  | "adminUserById"
  | "adminUsers"
  | "cancelAccountDeletionWithAudit"
  | "claimAdminPrincipal"
  | "recordAdminAudit"
  | "restoreUser"
  | "revokeUserSessions"
  | "adminControls"
  | "writeAdminControls"
  | "unsettledPurchasesForUser"
  | "subscriptionForUser"
  | "checkoutCreationForUser"
  | "suspendUser"
  | "deleteUserByAdmin"
  | "userByEmail"
  | "userById"
  | "appleSubscriptionsForUser";

export type SupportStoreMethod =
  | "adminSupportTickets"
  | "claimSupportRequestEvent"
  | "deleteOldSupportRequestEvents"
  | "insertSupportTicket"
  | "markSupportResponseSent"
  | "supportTicketById"
  | "updateSupportTicket";

export type ProductSignalEvent =
  | "preview_generated"
  | "onboarding_previewed"
  | "onboarding_saved"
  | "plan_saved"
  | "workout_started"
  | "workout_completed"
  | "upgrade_viewed"
  | "checkout_opened"
  | "upgrade_activated"
  | "recommendation_feedback_useful"
  | "recommendation_feedback_not_relevant"
  | "recommendation_feedback_not_clear";

export interface ProductSignalCountRow {
  event_day: string;
  event_name: ProductSignalEvent;
  event_count: number;
  member_count: number;
  anonymous_count: number;
}

export type ProductSignalAudience = "member" | "anonymous";
export interface ProductSignalsStore {
  /** True when this is the action's first count for the actor's daily key; a repeat changes nothing. */
  recordProductSignal(
    eventDay: string,
    eventName: ProductSignalEvent,
    actorKey: string,
    audience: ProductSignalAudience,
  ): Promise<boolean>;
  productSignalCounts(sinceDay: string, throughDay: string): Promise<ProductSignalCountRow[]>;
  deleteOldProductSignals(beforeDay: string): Promise<unknown>;
  deleteProductSignalActors(beforeDay: string): Promise<unknown>;
}

export type AuthStore = StoreCapabilities<AuthStoreMethod>;
export type AdminStore = { readonly kind: string } & StoreCapabilities<AdminStoreMethod>;
export type SupportStore = StoreCapabilities<SupportStoreMethod>;
export type ApplicationStore = { readonly kind: string } & AuthStore &
  AdminStore &
  SupportStore &
  SetupStore &
  ProductSignalsStore &
  TrainingStore &
  BillingStore &
  CoachingStore &
  DeviceStore &
  DataLayerStore &
  AiStore &
  AppleBillingStore &
  SocialAuthStore &
  ServerStateStore;

export interface AccountIdentityRow extends JsonObject {
  id: string;
  name: string;
  email: string;
  created_at: number;
  email_verified_at: number | null;
  auth_version: number;
  suspended_at: number | null;
}

export interface UserRow extends AccountIdentityRow {
  password_hash?: string;
  password_salt?: string;
}

export interface CredentialUserRow extends JsonObject {
  password_hash: string;
  password_salt: string;
}

export interface SessionRow extends AccountIdentityRow {
  token_hash: string;
  csrf_token: string;
  expires_at: number;
  session_created_at?: number;
}

export interface AccountSessionStoreRow extends JsonObject {
  token_hash: string;
  created_at: number;
  expires_at: number;
}

export interface AccountExportProfileRow extends JsonObject {
  id: string;
  name: string;
  email: string;
  created_at: number;
  email_verified_at: number | null;
}

export interface AccountExportStoreRows {
  profile: AccountExportProfileRow;
  weeklyPlan: JsonObject | null;
  monthlyPlan: JsonObject | null;
  preferences: JsonObject | null;
  ratings: JsonObject[];
  workouts: JsonObject[];
  checkIns: JsonObject[];
  trainingBlock: JsonObject | null;
  trainingAdaptations: JsonObject[];
  coachingProfile: JsonObject | null;
  coachingWeeks: JsonObject[];
  coachingLogs: CoachingDailyLogRow[];
  grants: JsonObject[];
  purchases: JsonObject[];
  subscriptions: JsonObject[];
  adjustments: JsonObject[];
  supportTickets: JsonObject[];
  deviceConnections: JsonObject[];
  wellnessNights: JsonObject[];
  wellnessDays: JsonObject[];
  wellnessWorkouts: JsonObject[];
  dailySnapshots: JsonObject[];
  planChanges: JsonObject[];
  trainingLinks: JsonObject[];
  aiSettings: JsonObject | null;
  aiUsage: JsonObject[];
  appleSubscriptions?: JsonObject[];
  signIns?: JsonObject[];
}

export interface AccountSelfServiceStore {
  accountSessions(
    userId: string,
    currentTokenHash: string,
    now: number,
  ): Promise<AccountSessionStoreRow[]>;
  revokeAccountSession(
    userId: string,
    targetTokenHash: string,
    currentTokenHash: string,
    now: number,
  ): Promise<boolean>;
  revokeOtherAccountSessions(
    userId: string,
    currentTokenHash: string,
    now: number,
  ): Promise<number>;
  accountExport(userId: string): Promise<AccountExportStoreRows | null>;
  accountExportWorkouts(
    userId: string,
    afterStartedAt: number,
    afterId: string,
    limit: number,
  ): Promise<JsonObject[]>;
}

export interface AccountPreparedStatementLike {
  get(...args: any[]): unknown;
  all(...args: any[]): unknown[];
}

export interface LocalAccountSelfServiceStoreDependencies {
  db: { exec(sql: string): unknown };
  statements: Record<string, AccountPreparedStatementLike>;
  plainRow: (row: unknown, columns?: string[]) => any;
}

export interface TursoAccountSelfServiceStoreDependencies {
  client: {
    batch(statements: { sql: string; args: any[] }[], mode: "read"): Promise<QueryResultLike[]>;
  };
  first(sql: string, args?: any[]): Promise<JsonObject | null>;
  run(sql: string, args?: any[]): Promise<QueryResultLike>;
  all(sql: string, args?: any[]): Promise<any[]>;
  plainRow: (row: unknown, columns?: string[]) => any;
}

export interface PreparedSession {
  token: string;
  csrfToken: string;
  record: {
    tokenHash: string;
    userId: string;
    csrfToken: string;
    expiresAt: number;
    createdAt: number;
    authVersion: number;
  };
}

export interface EmailConfig {
  readonly requestedEnabled: boolean;
  readonly flagValid: boolean;
  readonly configured: boolean;
  readonly deliveryConfigured: boolean;
  readonly secretConfigured: boolean;
  readonly enabled: boolean;
  readonly from: string;
  readonly replyTo: string;
  readonly supportEmail: string;
  readonly appBaseUrl: string;
  readonly missing: readonly string[];
}

export interface HttpHelpers {
  json(response: HttpResponse, status: number, data: unknown, headers?: HttpHeaders): void;
  bodyJson(request: HttpRequest): Promise<unknown>;
  bodyForm(request: HttpRequest): Promise<Record<string, string>>;
  redirect(response: HttpResponse, location: string, headers?: HttpHeaders): void;
  securityHeaders(): HttpHeaders;
}

export type JsonHttpHelpers = Pick<HttpHelpers, "json" | "bodyJson">;
export type AccountActionPurpose = "password_reset" | "account_delete";
export interface AccountActionDelivery {
  expiresAt: number;
  maskedEmail: string;
}

export interface WeeklyPlanExercise {
  instanceId: string;
  exerciseId: string;
  sets: number;
  reps: string;
}

export interface WeeklyPlan {
  version: number;
  restDay: string | null;
  restDays: string[];
  days: Record<string, WeeklyPlanExercise[]>;
}

export interface TrainingPreferences {
  version: number;
  goal: string;
  level: string;
  days: number;
  equipment: string[];
  preferences: string[];
  limitations: string[];
}

export interface PlanSnapshot {
  plan: WeeklyPlan;
  updatedAt: number;
  storedPlanJson: string | null;
}

export interface PreferencesSnapshot {
  preferences: TrainingPreferences;
  updatedAt: number;
  storedPreferencesJson: string | null;
}

export interface TrainingSetupInput {
  plan?: unknown;
  preferences?: unknown;
  expectedPlanUpdatedAt?: unknown;
  expectedPreferencesUpdatedAt?: unknown;
  expectedUserId?: unknown;
}

export interface SavedTrainingSetupRow {
  plan_json: string;
  updated_at: number;
  preferences_json: string;
  preferences_updated_at: number;
}

export interface SetupStore {
  saveTrainingSetup(
    userId: string,
    planJson: string,
    preferencesJson: string,
    updatedAt: number,
    expectedPlanUpdatedAt: number,
    expectedPreferencesUpdatedAt: number,
  ): Promise<SavedTrainingSetupRow | null>;
}

export interface EventBus {
  on(
    name: string,
    handler: (payload: Record<string, unknown>) => unknown,
    key?: string,
  ): () => void;
  emit(name: string, payload?: Record<string, unknown>): Promise<number>;
  retryDue?(limit?: number): Promise<number>;
  retryFor?(userId: string, limit?: number): Promise<number>;
  names: readonly string[];
}

/** One failed reaction (a handler for an event) waiting to be retried. */
export interface OutboxEventRecord {
  id: string;
  eventName: string;
  handlerKey: string;
  userId: string | null;
  payloadJson: string;
  attempts: number;
  attemptedAt: number;
  nextAttemptAt: number;
  lastError: string;
  createdAt: number;
}
export interface OutboxFailure {
  attempts: number;
  attemptedAt: number;
  nextAttemptAt: number;
  lastError: string;
  gaveUpAt: number | null;
}
export interface OutboxEventRow extends JsonObject {
  id: string;
  event_name: string;
  handler_key: string;
  user_id: string | null;
  payload_json: string;
  attempts: number;
}
export interface ServerStateStore {
  addOutboxEvent(record: OutboxEventRecord): Promise<void>;
  dueOutboxEvents(now: number, limit: number): Promise<OutboxEventRow[]>;
  userOutboxEvents(
    userId: string,
    now: number,
    attemptedBefore: number,
    limit: number,
  ): Promise<OutboxEventRow[]>;
  claimOutboxEvent(id: string, now: number, leaseUntil: number): Promise<boolean>;
  completeOutboxEvent(id: string): Promise<void>;
  failOutboxEvent(id: string, failure: OutboxFailure): Promise<void>;
  deleteOldOutboxEvents(before: number): Promise<void>;
  /** Takes one request slot in the key's fixed window; false when the window is full. */
  takeRateSlot(key: string, max: number, windowMs: number, now: number): Promise<boolean>;
  deleteOldRateBuckets(before: number): Promise<void>;
  /** Takes or renews a named lock until expiresAt; false while another holder has it. */
  acquireLock(name: string, holder: string, expiresAt: number, now: number): Promise<boolean>;
  releaseLock(name: string, holder: string): Promise<void>;
}

export interface SetupServiceDependencies {
  store: SetupStore;
  auth: Pick<AuthService, "validCsrf">;
  requireAccess: (request: HttpRequest, response: HttpResponse) => Promise<SessionRow | null>;
  trustedOrigin: (request: HttpRequest) => boolean;
  getPlanSnapshot: (userId: string) => Promise<PlanSnapshot>;
  getPreferencesSnapshot: (userId: string) => Promise<PreferencesSnapshot>;
  getUserPayload: (account: SessionRow) => Promise<unknown>;
  http: JsonHttpHelpers;
  events?: EventBus | null;
}

export interface SetupService {
  handleApi(request: HttpRequest, response: HttpResponse, url: URL): Promise<boolean>;
}

export interface WorkoutCheckInRecord {
  userId: string;
  workoutId: string;
  difficulty: number;
  energy: number;
  comfort: number;
  enjoyment: number;
  createdAt: number;
  updatedAt: number;
}

export interface TrainingBlockRecord {
  userId: string;
  blockJson: string;
  updatedAt: number;
}

export interface TrainingAdaptationRecord {
  userId: string;
  id: string;
  workoutId: string;
  adaptationJson: string;
  planUpdatedAt: number;
  createdAt: number;
  checkInUpdatedAt: number;
}

export interface TrainingMutationRecord {
  userId: string;
  id: string;
  planJson: string;
  expectedPlanUpdatedAt: number;
  expectedCheckInUpdatedAt: number;
  resolvedAt: number;
}

export interface TrainingStore {
  deleteWorkout(userId: string, id: string, expectedRevision: number): Promise<boolean>;
  workoutCheckIn(userId: string, workoutId: string): Promise<JsonObject | null>;
  upsertWorkoutCheckIn(record: WorkoutCheckInRecord): Promise<JsonObject | null>;
  trainingBlock(userId: string): Promise<JsonObject | null>;
  upsertTrainingBlock(
    record: TrainingBlockRecord,
    expectedRevision: number,
  ): Promise<JsonObject | null>;
  trainingAdaptation(userId: string, id: string): Promise<JsonObject | null>;
  latestTrainingAdaptation(userId: string): Promise<JsonObject | null>;
  upsertTrainingAdaptation(record: TrainingAdaptationRecord): Promise<JsonObject | null>;
  dismissTrainingAdaptation(
    userId: string,
    id: string,
    resolvedAt: number,
    checkInUpdatedAt?: number | null,
  ): Promise<JsonObject | null>;
  acceptTrainingAdaptation(
    record: TrainingMutationRecord,
  ): Promise<{ plan: JsonObject; adaptation: JsonObject } | null>;
}

export interface PreparedStatementLike {
  get(...args: any[]): unknown;
  run(...args: any[]): unknown;
  all(...args: any[]): unknown[];
}

export type BillingPreparedStatementName =
  | "pendingPurchasesForUser"
  | "unsettledPurchasesForUser"
  | "insertPendingPurchase"
  | "recordClaimedPurchase"
  | "replacePendingPurchaseCatalog"
  | "completePurchaseCatalogMigration"
  | "checkoutCreationForUser"
  | "claimCheckoutCreation"
  | "recordCheckoutCreationTransaction"
  | "extendCheckoutCreation"
  | "releaseCheckoutCreation"
  | "purchaseByTransaction"
  | "pendingPurchaseForUser"
  | "completePurchase"
  | "updatePurchaseStatus"
  | "bindPurchaseSubscription"
  | "createPaddleSubscription"
  | "updatePaddleSubscription"
  | "updatePaddleSubscriptionAfterCatalog"
  | "replaceSubscriptionPurchaseCatalog"
  | "subscriptionById"
  | "subscriptionForUser"
  | "upsertAdjustment"
  | "adjustmentById"
  | "revokePurchase"
  | "hasDiscoveryAccess"
  | "hasCurrentDiscoveryAccess"
  | "hasEntitledDiscoveryAccess"
  | "activeAdminGrant"
  | "discoveryAccessSummary"
  | "currentDiscoveryAccessSummary"
  | "entitledDiscoveryAccessSummary"
  | "webhookEvent"
  | "recordWebhookEvent";

export interface LocalBillingStoreDependencies {
  db: { exec(sql: string): unknown };
  statements: Record<BillingPreparedStatementName, PreparedStatementLike>;
  plainRow: <Row extends JsonObject>(row: unknown, columns?: string[]) => Row | null;
}

export interface TursoBillingStoreDependencies {
  client: {
    batch(
      statements: { sql: string; args: unknown[] }[],
      mode: "write",
    ): Promise<QueryResultLike[]>;
  };
  first: <Row extends JsonObject>(sql: string, args?: unknown[]) => Promise<Row | null>;
  run: (sql: string, args?: unknown[]) => Promise<QueryResultLike>;
  all: <Row extends JsonObject>(sql: string, args?: unknown[]) => Promise<Row[]>;
  plainRow: <Row extends JsonObject>(row: unknown, columns?: string[]) => Row | null;
}

export type TrainingPreparedStatementName =
  | "workoutCheckIn"
  | "upsertWorkoutCheckIn"
  | "trainingBlock"
  | "upsertTrainingBlock"
  | "deleteWorkout"
  | "trainingAdaptation"
  | "latestTrainingAdaptation"
  | "upsertTrainingAdaptation"
  | "dismissTrainingAdaptation"
  | "applyTrainingAdaptationPlan"
  | "acceptTrainingAdaptation"
  | "deleteTrainingAdaptationsForWorkout"
  | "deleteWorkoutCheckInForWorkout"
  | "deleteTrainingAdaptationsForDeletedUser"
  | "deleteWorkoutCheckInsForDeletedUser"
  | "deleteTrainingBlockForDeletedUser";

export interface QueryResultLike {
  rows?: any[];
  columns?: string[];
}

export interface LocalTrainingStoreDependencies {
  db: { exec(sql: string): unknown };
  statements: Record<TrainingPreparedStatementName, PreparedStatementLike>;
  plainRow: (row: unknown, columns?: string[]) => JsonObject | null;
}

export interface TursoTrainingStoreDependencies {
  client: {
    batch(statements: { sql: string; args: any[] }[], mode: "write"): Promise<QueryResultLike[]>;
  };
  first(sql: string, args?: any[]): Promise<JsonObject | null>;
  run(sql: string, args?: any[]): Promise<QueryResultLike>;
  plainRow: (row: unknown, columns?: string[]) => JsonObject | null;
}

export interface TrainingServiceStore extends TrainingStore {
  workout(userId: string, id: string): Promise<JsonObject | null>;
  workouts(userId: string, limit: number, offset: number): Promise<JsonObject[]>;
  plan(userId: string): Promise<JsonObject | null>;
}

export interface TrainingServiceDependencies {
  store: TrainingServiceStore;
  auth: Pick<AuthService, "validCsrf">;
  requireAccess: (request: HttpRequest, response: HttpResponse) => Promise<SessionRow | null>;
  trustedOrigin: (request: HttpRequest) => boolean;
  rateAllowed: (
    request: HttpRequest,
    key: string,
    limit: number,
    windowMs?: number,
  ) => boolean | Promise<boolean>;
  http: JsonHttpHelpers;
  events?: EventBus | null;
}

export interface TrainingService {
  handleApi(request: HttpRequest, response: HttpResponse, url: URL): Promise<boolean>;
}

export type CoachingGoal = "fat_loss" | "maintenance" | "muscle_gain";
export type CoachingExperience = "beginner" | "intermediate" | "advanced";
export type CoachingDailyMovement =
  "mostly_seated" | "lightly_moving" | "on_feet" | "physically_demanding";
export type CoachingAdditionalActivityIntensity = "light" | "moderate" | "vigorous";
export interface CoachingCapability {
  exerciseId: string;
  maxSets: number;
  maxReps: number;
  maxWeightKg: number | null;
}
export type FoodAllergen =
  | "milk"
  | "egg"
  | "fish"
  | "crustacean_shellfish"
  | "tree_nuts"
  | "peanuts"
  | "wheat"
  | "soy"
  | "sesame";
export type DietaryPattern = "omnivore" | "pescatarian" | "vegetarian" | "vegan";
export type DietaryRequirement = "gluten_free" | "dairy_free";
export interface MealPreferences extends JsonObject {
  allergyStatus: "none_known" | "listed" | "other_or_unsure";
  allergens: FoodAllergen[];
  otherAllergies: string;
  dietaryPattern: DietaryPattern;
  dietaryRequirements: DietaryRequirement[];
  favoriteFoods: string[];
  mealsPerDay: number;
  dailyBudgetCents: number | null;
}
export interface CoachingProfileBase extends JsonObject {
  measurementSystem: "metric" | "imperial";
  preferredLoadUnit: "kg" | "lb";
  age: number;
  heightCm: number;
  weightKg: number;
  bodyFatPercent: number | null;
  goal: CoachingGoal;
  trainingGoal: "balanced" | "strength" | "hypertrophy";
  goalPace: "gentle" | "moderate";
  experience: CoachingExperience;
  workoutDays: string[];
  sessionsPerWeek: number;
  sessionMinutes: 30 | 45 | 60 | 75 | 90;
  usualExercises: CoachingCapability[];
  availableEquipment: string[];
  movementLimitations: string[];
  caloriePattern: "steady" | "zigzag" | "flexible_day";
  flexibleDay: string | null;
  macroPreference: "balanced" | "higher_protein" | null;
  timeZone: string;
  mealPreferences: MealPreferences | null;
}
export interface LegacyCoachingProfile extends CoachingProfileBase {
  version: 1 | 2 | 3;
  sexForEquation: "female" | "male" | null;
  lifestyleActivity: string;
  dailyMovement?: never;
  additionalActivityMinutesPerWeek?: never;
  additionalActivityIntensity?: never;
}
export interface StructuredCoachingProfile extends CoachingProfileBase {
  version: 4;
  sexForEquation: "female" | "male";
  lifestyleActivity?: never;
  dailyMovement: CoachingDailyMovement;
  additionalActivityMinutesPerWeek: number;
  additionalActivityIntensity: CoachingAdditionalActivityIntensity;
}
export type CoachingProfile = LegacyCoachingProfile | StructuredCoachingProfile;
export type CoachingProfilePayload = CoachingProfile & { revision: number; updatedAt: number };
export interface CoachingWeekRecord {
  userId: string;
  weekStart: string;
  planKey: string;
  profileRevision: number;
  snapshotJson: string;
  generatedAt: number;
}
export interface CoachingDailyLogRecord {
  userId: string;
  logDate: string;
  calories: number;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  morningWeightKg: number | null;
  complete: boolean | null;
  updatedAt: number;
}
export interface CoachingDailyLogRow extends JsonObject {
  log_date: string;
  calories: number;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  morning_weight_kg: number | null;
  intake_complete: 0 | 1 | null;
  revision: number;
  updated_at: number;
}
/** Strata AI consent and the organization's daily provider budget. */
export interface AiJobRecord {
  id: string;
  userId: string;
  kind: "chat" | "suggestions";
  requestJson: string;
  usageDate: string;
  createdAt: number;
}
export interface AiJobOutcome {
  status: "done" | "failed";
  tokens: number;
  resultJson: string | null;
  errorJson: string | null;
  finishedAt: number;
}
export interface AiJobRow extends JsonObject {
  id: string;
  user_id: string;
  kind: "chat" | "suggestions";
  status: "queued" | "running" | "done" | "failed";
  request_json: string | null;
  usage_date: string;
  tokens: number;
  result_json: string | null;
  error_json: string | null;
  created_at: number;
  finished_at: number | null;
}
export interface AiStore {
  aiSettings(userId: string): Promise<JsonObject | null>;
  upsertAiSettings(
    userId: string,
    settings: {
      consentAt: number | null;
      consentVersion: number;
      dailyBrief: boolean;
      updatedAt: number;
    },
  ): Promise<JsonObject | null>;
  briefCandidates(limit: number, offset: number): Promise<JsonObject[]>;
  aiUsage(date: string, scope: string): Promise<JsonObject[]>;
  addAiUsage(
    date: string,
    scope: string,
    kind: "chat" | "brief",
    requests: number,
    tokens: number,
  ): Promise<void>;
  /** Adds one request for the member unless it would pass the limit; false means the allowance is spent. */
  claimMemberAiRequest(
    date: string,
    userId: string,
    kind: "chat" | "brief",
    limit: number,
  ): Promise<boolean>;
  /** Adds one shared request unless today's total or this kind's share is spent. */
  claimGlobalAiRequest(
    date: string,
    kind: "chat" | "brief",
    dailyLimit: number,
    kindLimit: number,
  ): Promise<boolean>;
  /** Queues a request; fails with a unique violation while the member already has one queued or running. */
  insertAiJob(job: AiJobRecord): Promise<AiJobRow | null>;
  aiJob(id: string, userId: string): Promise<AiJobRow | null>;
  activeAiJob(userId: string): Promise<AiJobRow | null>;
  queuedAiJobs(): Promise<number>;
  aiJobPosition(id: string): Promise<number>;
  claimAiJob(leaseUntil: number): Promise<AiJobRow | null>;
  finishAiJob(id: string, outcome: AiJobOutcome): Promise<void>;
  requeueStaleAiJobs(now: number): Promise<void>;
  deleteFinishedAiJobs(before: number): Promise<void>;
  refundAiUsage(date: string, scope: string, kind: "chat" | "brief"): Promise<void>;
  aiUsageTotals(date: string): Promise<JsonObject[]>;
  aiUsageTop(date: string, limit: number): Promise<JsonObject[]>;
  deleteOldAiUsage(beforeDate: string): Promise<void>;
}
/** Shared data layer: Polar-to-workout links, Daily Snapshots, and where each saved week came from. */
export interface DataLayerStore {
  trainingLinks(userId: string): Promise<JsonObject[]>;
  upsertTrainingLink(
    userId: string,
    link: {
      provider: string;
      externalId: string;
      workoutId: string;
      method: string;
      linkedAt: number;
    },
  ): Promise<void>;
  deleteTrainingLink(userId: string, provider: string, externalId: string): Promise<void>;
  deleteTrainingLinksForProvider(userId: string, provider: string): Promise<void>;
  dailySnapshots(userId: string, fromDate: string, toDate: string): Promise<JsonObject[]>;
  upsertDailySnapshot(
    userId: string,
    date: string,
    snapshotJson: string,
    updatedAt: number,
  ): Promise<void>;
  saveDailyBrief(
    userId: string,
    date: string,
    briefJson: string,
    generatedAt: number,
  ): Promise<boolean>;
  deleteDailyBriefs(userId: string, updatedAt: number): Promise<void>;
  deleteOldDailySnapshots(beforeDate: string): Promise<void>;
  deleteUserDailySnapshots(userId: string): Promise<void>;
  insertPlanChange(
    userId: string,
    change: { planUpdatedAt: number; source: string; detail: string; createdAt: number },
    keep?: number,
  ): Promise<void>;
  planChanges(userId: string, limit: number): Promise<JsonObject[]>;
}
export interface CoachingStore {
  coachingProfile(userId: string): Promise<JsonObject | null>;
  upsertCoachingProfile(
    userId: string,
    profileJson: string,
    updatedAt: number,
    expectedRevision: number,
  ): Promise<JsonObject | null>;
  coachingWeek(userId: string, weekStart: string): Promise<JsonObject | null>;
  upsertCoachingWeek(record: CoachingWeekRecord): Promise<JsonObject | null>;
  coachingDailyLog(userId: string, logDate: string): Promise<CoachingDailyLogRow | null>;
  coachingDailyLogs(
    userId: string,
    startDate: string,
    endDate: string,
  ): Promise<CoachingDailyLogRow[]>;
  upsertCoachingDailyLog(
    record: CoachingDailyLogRecord,
    expectedRevision: number,
  ): Promise<CoachingDailyLogRow | null>;
}
export interface LocalCoachingStoreDependencies {
  statements: Record<string, PreparedStatementLike>;
  plainRow: (row: unknown, columns?: string[]) => any;
}
export interface TursoCoachingStoreDependencies {
  first(sql: string, args?: any[]): Promise<any>;
  all(sql: string, args?: any[]): Promise<any[]>;
}

export interface WellnessOwner {
  userId: string;
  provider: string;
  providerUserId: string;
}
export interface WellnessNightRecord {
  nightDate: string;
  recoveryStatus: number | null;
  ansCharge: number | null;
  ansChargeStatus: number | null;
  sleepCharge: number | null;
  heartRateAvg: number | null;
  hrvAvg: number | null;
  breathingRateAvg: number | null;
  sleepScore: number | null;
  sleepStart: string | null;
  sleepEnd: string | null;
  asleepSeconds: number | null;
  lightSeconds: number | null;
  deepSeconds: number | null;
  remSeconds: number | null;
  interruptionSeconds: number | null;
  updatedAt: number;
}
export interface WellnessDayRecord {
  dayDate: string;
  restingHr: number | null;
  minHr: number | null;
  avgHr: number | null;
  maxHr: number | null;
  samples: number;
  bucketsJson: string | null;
  updatedAt: number;
}
export interface WellnessWorkoutRecord {
  externalId: string;
  startedAt: number;
  localDate: string;
  durationSeconds: number;
  sport: string;
  calories: number | null;
  hrAvg: number | null;
  hrMax: number | null;
  cardioLoad: number | null;
  updatedAt: number;
}
export interface DeviceConnectionRecord {
  userId: string;
  provider: string;
  providerUserId: string;
  memberRef: string;
  tokenSealed: string;
  tokenExpiresAt: number | null;
  settingsJson: string;
  consentVersion: string;
  connectedAt: number;
  nextSyncAt: number;
  updatedAt: number;
}
export interface DeviceTokenRecord extends WellnessOwner {
  tokenSealed: string;
  tokenExpiresAt: number;
  updatedAt: number;
}
export interface DeviceSyncRecord {
  userId: string;
  provider: string;
  providerUserId: string;
  status: string;
  syncedThrough: string | null;
  lastSyncAt: number | null;
  lastError: string | null;
  nextSyncAt: number;
  failures: number;
  updatedAt: number;
}
export interface DeviceConnectStateRecord {
  stateHash: string;
  userId: string;
  provider: string;
  sessionHash: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
}
export interface DeviceStore {
  deviceConnection(userId: string, provider: string): Promise<any>;
  deviceConnectionByProviderUser(provider: string, providerUserId: string): Promise<any>;
  insertDeviceConnectState(record: DeviceConnectStateRecord): Promise<boolean>;
  readDeviceConnectState(stateHash: string): Promise<any>;
  consumeDeviceConnectState(
    stateHash: string,
    userId: string,
    sessionHash: string,
    now: number,
  ): Promise<any>;
  discardDeviceConnectState(stateHash: string, now: number): Promise<void>;
  upsertDeviceConnection(record: DeviceConnectionRecord): Promise<any>;
  updateDeviceToken(record: DeviceTokenRecord): Promise<boolean>;
  recordDeviceSync(record: DeviceSyncRecord): Promise<boolean>;
  markDeviceConnectionDue(
    provider: string,
    providerUserId: string,
    dueAt: number,
    now: number,
  ): Promise<any>;
  dueDeviceConnections(now: number, limit: number): Promise<any[]>;
  updateDeviceSettings(
    userId: string,
    provider: string,
    settingsJson: string,
    expectedRevision: number,
    updatedAt: number,
  ): Promise<any>;
  deleteDeviceData(userId: string, provider: string): Promise<any>;
  upsertWellnessNight(owner: WellnessOwner, night: WellnessNightRecord): Promise<void>;
  upsertWellnessDay(owner: WellnessOwner, day: WellnessDayRecord): Promise<void>;
  upsertWellnessWorkout(owner: WellnessOwner, workout: WellnessWorkoutRecord): Promise<void>;
  wellnessNights(
    userId: string,
    provider: string,
    fromDate: string,
    toDate: string,
  ): Promise<any[]>;
  wellnessDays(userId: string, provider: string, fromDate: string, toDate: string): Promise<any[]>;
  wellnessWorkouts(
    userId: string,
    provider: string,
    fromTime: number,
    toTime: number,
  ): Promise<any[]>;
  deleteExpiredDeviceData(now: number): Promise<void>;
}
export interface LocalDeviceStoreDependencies {
  db: { exec(sql: string): unknown };
  statements: Record<string, PreparedStatementLike>;
  plainRow: (row: unknown, columns?: string[]) => any;
}
export interface TursoDeviceStoreDependencies {
  client: {
    batch(statements: { sql: string; args: any[] }[], mode: "write"): Promise<QueryResultLike[]>;
  };
  first(sql: string, args?: any[]): Promise<any>;
  all(sql: string, args?: any[]): Promise<any[]>;
  run(sql: string, args?: any[]): Promise<QueryResultLike>;
  plainRow: (row: unknown, columns?: string[]) => any;
}

export type SocialProviderId = "google";
export interface SocialSignInStateRecord {
  stateHash: string;
  provider: SocialProviderId;
  browserHash: string;
  nonce: string;
  codeVerifier: string;
  intent: "signup" | "login";
  nextPath: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
}
/** `at` is when the identity was linked or, for touchAccountIdentity, last used. */
export interface AccountIdentityRecord {
  provider: SocialProviderId;
  subject: string;
  userId: string;
  email: string;
  at: number;
}
export interface SocialAccountRecord {
  id: string;
  name: string;
  email: string;
  createdAt: number;
}
export interface SignInMethods {
  hasPassword: boolean;
  providers: string[];
}
export interface SocialAuthStore {
  insertSocialSignInState(record: SocialSignInStateRecord): Promise<boolean>;
  recordSocialSignInReturn(
    stateHash: string,
    provider: SocialProviderId,
    code: string,
    now: number,
  ): Promise<any>;
  discardSocialSignInState(stateHash: string): Promise<any>;
  consumeSocialSignInState(stateHash: string, browserHash: string, now: number): Promise<any>;
  accountIdentity(provider: SocialProviderId, subject: string): Promise<any>;
  accountIdentities(userId: string): Promise<any[]>;
  accountSignInMethods(userId: string): Promise<SignInMethods | null>;
  linkAccountIdentity(identity: AccountIdentityRecord): Promise<boolean>;
  touchAccountIdentity(identity: AccountIdentityRecord): Promise<boolean>;
  createSocialAccount(
    account: SocialAccountRecord,
    identity: AccountIdentityRecord,
  ): Promise<AccountIdentityRow | null>;
  deleteExpiredSocialSignInData(now: number): Promise<void>;
}
export type LocalSocialAuthStoreDependencies = LocalDeviceStoreDependencies;
export type TursoSocialAuthStoreDependencies = TursoDeviceStoreDependencies;
export interface CoachingServiceDependencies {
  store: CoachingStore & Pick<TrainingServiceStore, "workouts" | "workout" | "workoutCheckIn">;
  auth: Pick<AuthService, "validCsrf">;
  requireAccess: (request: HttpRequest, response: HttpResponse) => Promise<SessionRow | null>;
  trustedOrigin: (request: HttpRequest) => boolean;
  rateAllowed: (
    request: HttpRequest,
    key: string,
    limit: number,
    windowMs?: number,
  ) => boolean | Promise<boolean>;
  http: JsonHttpHelpers;
  now?: () => number;
  events?: EventBus | null;
  /** The member's saved weekly plan; the coaching week reads its training sessions from it. */
  getPlan?: (userId: string) => Promise<unknown>;
}
export interface CoachingService {
  handleApi(request: HttpRequest, response: HttpResponse, url: URL): Promise<boolean>;
}

export interface ProductSignalsServiceDependencies {
  store: ProductSignalsStore;
  admin: Pick<AdminService, "requireAdmin">;
  auth: Pick<AuthService, "sessionFor" | "validCsrf">;
  trustedOrigin: (request: HttpRequest) => boolean;
  requestAddress: (request: HttpRequest) => string;
  rateKeyAllowed: (key: string, limit: number, windowMs: number) => boolean | Promise<boolean>;
  http: JsonHttpHelpers;
  now?: () => number;
}

export interface ProductSignalsService {
  handleApi(request: HttpRequest, response: HttpResponse, url: URL): Promise<boolean>;
  cleanup(timestamp?: number): Promise<unknown>;
}

export interface AuthServiceDependencies {
  store: AuthStore;
  emailConfig: EmailConfig;
  environment?: NodeJS.ProcessEnv;
  exerciseIds?: Set<string>;
  isUniqueViolation?: (error: unknown) => boolean;
  trustedAuthOrigin: (request: HttpRequest) => boolean;
  rateAllowed: (
    request: HttpRequest,
    key: string,
    limit: number,
    windowMs?: number,
  ) => boolean | Promise<boolean>;
  http: HttpHelpers;
  getUserPayload: (account: AccountIdentityRow) => Promise<unknown>;
  claimAdminForLogin?: (user: UserRow) => Promise<UserRow>;
  reconcileCheckoutCreationBeforeDeletion: (
    userId: string,
    expectedClaimId?: string,
  ) => Promise<number>;
  reconcileUnsettledPurchases: (
    userId: string,
    options?: { includeFresh?: boolean; checkSubscription?: boolean; transactionIds?: string[] },
  ) => Promise<number>;
  appleDeletionNotice?: (userId: string) => Promise<AppleDeletionNotice | null>;
  logger?: Pick<Console, "info" | "error">;
}

export interface AccountSelfServiceDependencies {
  store: AccountSelfServiceStore;
  http: Pick<HttpHelpers, "json" | "bodyJson" | "securityHeaders">;
  requireSession: (request: HttpRequest, response: HttpResponse) => Promise<SessionRow | null>;
  validCsrf: (request: HttpRequest, session: SessionRow) => boolean;
  rateAllowed: (
    request: HttpRequest,
    key: string,
    limit: number,
    windowMs?: number,
  ) => boolean | Promise<boolean>;
  logger?: Pick<Console, "error">;
  now?: () => number;
}

export interface AccountSelfService {
  handleApi(request: HttpRequest, response: HttpResponse, url: URL): Promise<boolean>;
}

export interface AccountDeletionResult {
  status: "deleted" | "invalid" | "purchase_pending" | "checkout_pending";
  user?: { id: string; email: string };
}
export interface DeletedAccount {
  user: AccountDeletionResult["user"];
  appleBilling: AppleDeletionNotice | null;
}

/** One account deletion, by emailed link or in the app: who, why (for the audit log), and how the store removes it. */
export interface ProtectedAccountDeletion {
  userId: string;
  email: string;
  purpose: "account_delete" | "account_delete_in_app";
  remove: (deletedAt: number, emailHash: string) => Promise<AccountDeletionResult>;
  invalid: () => Error;
}

export interface AccountDeletionDependencies {
  store: StoreCapabilities<"adminPrincipal" | "accountCredentialsById" | "deleteAccountForUser">;
  http: JsonHttpHelpers;
  requireSession: (request: HttpRequest, response: HttpResponse) => Promise<SessionRow | null>;
  validCsrf: (request: HttpRequest, session: SessionRow) => boolean;
  trustedAuthOrigin: (request: HttpRequest) => boolean;
  rateAllowed: (
    request: HttpRequest,
    key: string,
    limit: number,
    windowMs?: number,
  ) => boolean | Promise<boolean>;
  passwordMatches: (password: string, user: CredentialUserRow) => Promise<boolean>;
  accountEmailHash: (email: string) => string;
  accountActionError: (
    message: string,
    status: number,
    code: string,
  ) => Error & { status: number; code: string };
  storageUnavailable: (error: unknown) => Error;
  audit: (event: string, details: { purpose: string; email: string }) => void;
  clearCookies: () => string[];
  reconcileCheckoutCreationBeforeDeletion: (userId: string) => Promise<number>;
  reconcileUnsettledPurchases: (userId: string) => Promise<number>;
  appleDeletionNotice: (userId: string) => Promise<AppleDeletionNotice | null>;
  now?: () => number;
}

export interface AccountDeletion {
  handleApi(request: HttpRequest, response: HttpResponse, url: URL): Promise<boolean>;
  deleteProtectedAccount(request: ProtectedAccountDeletion): Promise<DeletedAccount>;
  deleteSignedInAccount(session: SessionRow, input: unknown): Promise<DeletedAccount>;
}

export interface AuthService {
  handleApi(request: HttpRequest, response: HttpResponse, url: URL): Promise<boolean>;
  handleForm(request: HttpRequest, response: HttpResponse, url: URL): Promise<void>;
  cleanup(now?: number): Promise<void>;
  sessionFor(request: HttpRequest, response?: HttpResponse | null): Promise<SessionRow | null>;
  requireSession(request: HttpRequest, response: HttpResponse): Promise<SessionRow | null>;
  sessionCookie(token: string, maxAge?: number): string;
  signupCookie(token: string, maxAge?: number): string;
  prepareSession(userId: string, now?: number, authVersion?: number): PreparedSession;
  passwordMatches(password: string, user: CredentialUserRow): Promise<boolean>;
  validCsrf(request: HttpRequest, session: SessionRow): boolean;
  requestSignedInAccountAction(
    account: AccountIdentityRow,
    purpose: AccountActionPurpose,
  ): Promise<AccountActionDelivery>;
  accountActionError(
    message: string,
    status: number,
    code: string,
  ): Error & { status: number; code: string };
  accountEmailHash(email: string): string;
  normalizeEmail(value: unknown): string;
  hashToken(token: string): string;
  safeAccountNext(value: unknown): string;
  accountErrorLocation(mode: string, message: string, requestedNext: unknown): string;
  [method: string]: unknown;
}

export interface SocialAuthServiceDependencies {
  store: SocialAuthStore & StoreCapabilities<"userByEmail" | "insertSession">;
  settings: ReturnType<typeof import("./social-auth-config").socialAuthSettings>;
  getAuth: () => AuthService | undefined;
  claimAdminForLogin?: (user: any) => Promise<any>;
  trustedAuthOrigin: (request: HttpRequest) => boolean;
  rateAllowed: (
    request: HttpRequest,
    key: string,
    limit: number,
    windowMs?: number,
  ) => boolean | Promise<boolean>;
  http: Pick<HttpHelpers, "bodyForm" | "redirect" | "securityHeaders">;
  isUniqueViolation?: (error: unknown) => boolean;
  client?: ReturnType<typeof import("./social-auth-client").createSocialAuthClient> | null;
  fetchImpl?: typeof fetch;
  logger?: { info?: Function; warn?: Function; error?: Function } | null;
  now?: () => number;
}

export interface SocialAuthService {
  handle(request: HttpRequest, response: HttpResponse, url: URL): Promise<boolean>;
  renderAccountPage(html: string): string;
  enabledProviders(): SocialProviderId[];
  cleanup(now?: number): Promise<void>;
}

export interface AdminServiceDependencies {
  store: AdminStore;
  adminEmail: string;
  auth: AuthService;
  emailConfig: Pick<EmailConfig, "enabled"> & Partial<Pick<EmailConfig, "configured">>;
  paymentConfig: Pick<PaymentConfig, "enabled"> & Partial<Pick<PaymentConfig, "configured">>;
  trustedAuthOrigin: (request: HttpRequest) => boolean;
  rateAllowed: (
    request: HttpRequest,
    key: string,
    limit: number,
    windowMs?: number,
  ) => boolean | Promise<boolean>;
  http: JsonHttpHelpers;
  environment?: NodeJS.ProcessEnv;
  enforcePaddleIps?: boolean;
  /** Setup the public status no longer shows; read when the Overview loads. */
  serviceStatus?: () => AdminServiceStatus;
  reconcileCheckoutCreationBeforeDeletion: (
    userId: string,
    expectedClaimId?: string,
  ) => Promise<number>;
  reconcileUnsettledPurchases: (
    userId: string,
    options?: { includeFresh?: boolean; checkSubscription?: boolean; transactionIds?: string[] },
  ) => Promise<number>;
}

export interface AdminService {
  handleApi(request: HttpRequest, response: HttpResponse, url: URL): Promise<boolean>;
  bootstrap(): Promise<void>;
  cleanup(now?: number): Promise<void>;
  adminIdentity(
    session: AccountIdentityRow,
    options?: { allowBootstrap?: boolean },
  ): Promise<{ active: boolean; boundNow: boolean; principal: JsonObject | null }>;
  maybeClaimAdminForLogin(user: UserRow): Promise<UserRow>;
  requireAdmin(
    request: HttpRequest,
    response: HttpResponse,
    options?: { allowBootstrap?: boolean },
  ): Promise<SessionRow | null>;
  requireAdminMutation(request: HttpRequest, response: HttpResponse, session: SessionRow): boolean;
  sensitiveAdminText(value: unknown): boolean;
  cleanAdminTarget(value: unknown): string;
  adminAuditEvent(
    actorUserId: string,
    targetUserId: string | null,
    action: string,
    reason: string,
    result?: string,
  ): JsonObject;
  recordAdminAudit(
    actorUserId: string,
    targetUserId: string | null,
    action: string,
    reason: string,
    result?: string,
  ): Promise<void>;
  [method: string]: unknown;
}

export interface SupportServiceDependencies {
  store: SupportStore;
  emailConfig: EmailConfig;
  auth: AuthService;
  admin: AdminService;
  requestAddress: (request: HttpRequest) => string;
  trustedAuthOrigin: (request: HttpRequest) => boolean;
  rateAllowed: (
    request: HttpRequest,
    key: string,
    limit: number,
    windowMs?: number,
  ) => boolean | Promise<boolean>;
  isUniqueViolation?: (error: unknown) => boolean;
  http: Pick<HttpHelpers, "json" | "bodyJson" | "bodyForm" | "redirect">;
  logger?: Pick<Console, "error">;
}

export interface SupportService {
  handleApi(request: HttpRequest, response: HttpResponse, url: URL): Promise<boolean>;
  cleanup(now?: number): Promise<void>;
  supportTicketPayload(row: JsonObject): JsonObject;
}

export type CreateAuthService = (dependencies: AuthServiceDependencies) => AuthService;
export type CreateAdminService = (dependencies: AdminServiceDependencies) => AdminService;
export type CreateSupportService = (dependencies: SupportServiceDependencies) => SupportService;
export type CreateSetupService = (dependencies: SetupServiceDependencies) => SetupService;
export type CreateTrainingService = (dependencies: TrainingServiceDependencies) => TrainingService;

export interface AdminServiceStatus {
  appStore: boolean;
  signInProviders: readonly string[];
}

export interface ServiceCompositionDependencies {
  store: ApplicationStore;
  emailConfig: EmailConfig;
  paymentConfig: PaymentConfig;
  adminEmail: string;
  enforcePaddleIps: boolean;
  exerciseIds: Set<string>;
  trustedAuthOrigin: (request: HttpRequest) => boolean;
  rateAllowed: (
    request: HttpRequest,
    key: string,
    limit: number,
    windowMs?: number,
  ) => boolean | Promise<boolean>;
  requestAddress: (request: HttpRequest) => string;
  http: HttpHelpers;
  getUserPayload: (account: AccountIdentityRow) => Promise<unknown>;
  reconcileCheckoutCreationBeforeDeletion: (
    userId: string,
    expectedClaimId?: string,
  ) => Promise<number>;
  reconcileUnsettledPurchases: (
    userId: string,
    options?: { includeFresh?: boolean; checkSubscription?: boolean; transactionIds?: string[] },
  ) => Promise<number>;
  isUniqueViolation: (error: unknown) => boolean;
  appleDeletionNotice?: (userId: string) => Promise<AppleDeletionNotice | null>;
  serviceStatus?: () => AdminServiceStatus;
  createAuthService: CreateAuthService;
  createAdminService: CreateAdminService;
  createSupportService: CreateSupportService;
}

export type AppleEnvironment = "Production" | "Sandbox";
/** Whether a Sandbox purchase unlocks Strata+: always outside production, else only for the listed account emails. */
export interface AppleSandboxPolicy {
  readonly allowSandbox: boolean;
  readonly sandboxAccounts: ReadonlySet<string>;
}
export interface AppleBillingSettings extends AppleSandboxPolicy {
  readonly bundleId: string;
  readonly productIds: readonly string[];
  readonly rootFingerprint: string;
  readonly rootOverrideIgnored: boolean;
  readonly configured: boolean;
}
/** A verified StoreKit 2 transaction for a Strata+ product of this app. */
export interface AppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  environment: AppleEnvironment;
  purchaseDate: number;
  originalPurchaseDate: number | null;
  expiresDate: number;
  signedDate: number;
  revocationDate: number | null;
  revocationReason: number | null;
  appAccountToken: string | null;
}
export interface AppleRenewal {
  autoRenew: boolean | null;
  gracePeriodExpiresAt: number | null;
}
export interface AppleSubscriptionRow extends JsonObject {
  original_transaction_id: string;
  user_id: string;
  product_id: string;
  environment: AppleEnvironment;
  latest_transaction_id: string;
  purchased_at: number | null;
  original_purchased_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  revocation_reason: string | null;
  auto_renew: 0 | 1 | null;
  grace_period_expires_at: number | null;
  last_signed_at: number;
  latest_signed_at: number;
  created_at: number;
  updated_at: number;
}
export interface AppleSubscriptionWrite {
  originalTransactionId: string;
  userId: string;
  productId: string;
  environment: AppleEnvironment;
  latestTransactionId: string;
  purchasedAt: number | null;
  originalPurchasedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  revocationReason: string | null;
  autoRenew: boolean | null;
  gracePeriodExpiresAt: number | null;
  lastSignedAt: number;
  latestSignedAt: number;
  createdAt: number;
  updatedAt: number;
}
export interface AppleNotificationWrite {
  notificationUuid: string;
  notificationType: string;
  subtype: string | null;
  outcome: string;
  signedAt: number;
  processedAt: number;
}
export interface AppleBillingStore {
  appleSubscription(originalTransactionId: string): Promise<AppleSubscriptionRow | null>;
  appleSubscriptionsForUser(userId: string): Promise<AppleSubscriptionRow[]>;
  upsertAppleSubscription(
    record: AppleSubscriptionWrite,
    replaceOwnerId?: string | null,
  ): Promise<AppleSubscriptionRow | null>;
  hasActiveAppleSubscription(
    userId: string,
    now: number,
    sandbox?: AppleSandboxPolicy,
  ): Promise<boolean>;
  appleNotification(notificationUuid: string): Promise<JsonObject | null>;
  recordAppleNotification(notification: AppleNotificationWrite): Promise<boolean>;
  deleteOldAppleNotifications(before: number): Promise<void>;
}
/** /api/me "discovery.apple". */
export interface AppleSubscriptionSummary {
  active: boolean;
  productId: string;
  expiresAt: number | null;
  autoRenew: boolean | null;
  inGracePeriod: boolean;
  environment: AppleEnvironment;
  revoked: boolean;
}
export interface AppleDeletionNotice {
  message: string;
  manageUrl: string;
}
export interface AppleBillingServiceDependencies {
  store: AppleBillingStore & { userById(userId: string): Promise<JsonObject | null> };
  settings: AppleBillingSettings;
  getAuth: () => Pick<AuthService, "requireSession" | "validCsrf"> | undefined;
  getUserPayload: (account: SessionRow) => Promise<JsonObject>;
  trustedOrigin: (request: HttpRequest) => boolean;
  rateAllowed: (
    request: HttpRequest,
    key: string,
    limit: number,
    windowMs?: number,
  ) => boolean | Promise<boolean>;
  http: Pick<HttpHelpers, "json">;
  logger: OperationalLogger;
  now?: () => number;
  verify?: (
    token: string,
    options: { rootFingerprint?: string; now?: number },
  ) => Record<string, any>;
}
export interface AppleBillingService {
  handleApi(request: HttpRequest, response: HttpResponse, url: URL): Promise<boolean>;
  handleNotification(request: HttpRequest, response: HttpResponse): Promise<void>;
  processNotification(payload: Record<string, any>): Promise<string>;
  subscriptionForUser(
    userId: string,
    email?: string | null,
  ): Promise<AppleSubscriptionSummary | null>;
  deletionNotice(userId: string): Promise<AppleDeletionNotice | null>;
  cleanup(): Promise<void>;
}
