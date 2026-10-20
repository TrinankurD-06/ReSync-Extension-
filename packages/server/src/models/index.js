// MongoDB models (Mongoose). What the server stores (spec section 6): users, teams, invites, prompts with
// version history, colour presets/settings, usage NUMBERS, queue report summaries, and passports/summaries
// only when a user explicitly shares one. Never API keys. Never full conversations.
import mongoose from 'mongoose';

const { Schema } = mongoose;
const id = Schema.Types.ObjectId;

const userSchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 200 },
    email: { type: String, maxlength: 320, lowercase: true, trim: true },
    avatarUrl: { type: String, maxlength: 1000 },
    // Stable ids from identity providers (GitHub numeric id, Google "sub"): never key users on email.
    identities: [{ provider: { type: String, enum: ['github', 'google', 'dev'], required: true }, subject: { type: String, required: true } }],
    teamId: { type: id, ref: 'Team', index: true },
    role: { type: String, enum: ['owner', 'member'] },
    settings: { type: Schema.Types.Mixed, default: {} }, // non-secret client settings
    colours: { presets: { type: Array, default: [] }, assignments: { type: Schema.Types.Mixed, default: {} }, preset: String },
  },
  { timestamps: true, minimize: false },
);
userSchema.index({ 'identities.provider': 1, 'identities.subject': 1 }, { unique: true, sparse: true });

const teamSchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 120 },
    ownerId: { type: id, ref: 'User', required: true },
    // Decision Ledger sync stores decision TEXT, so the owner must turn it on (off by default).
    ledgerSync: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const inviteSchema = new Schema(
  {
    teamId: { type: id, ref: 'Team', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    role: { type: String, enum: ['member'], default: 'member' },
    createdBy: { type: id, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    usedBy: { type: id, ref: 'User' },
    usedAt: Date,
    revokedAt: Date,
  },
  { timestamps: true },
);

// Session tokens (dashboard cookie) and personal tokens (CLI / extension) share one model: hashed, revocable.
const tokenSchema = new Schema(
  {
    userId: { type: id, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['session', 'personal'], required: true },
    label: { type: String, maxlength: 120, default: '' },
    hash: { type: String, required: true, unique: true },
    lastUsedAt: Date,
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
  },
  { timestamps: true },
);
tokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 86400 }); // purge a week after expiry

const deviceCodeSchema = new Schema(
  {
    deviceCodeHash: { type: String, required: true, unique: true },
    userCode: { type: String, required: true, unique: true },
    label: { type: String, maxlength: 120, default: '' },
    status: { type: String, enum: ['pending', 'approved', 'denied', 'used'], default: 'pending' },
    userId: { type: id, ref: 'User' },
    interval: { type: Number, default: 5 },
    lastPolledAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
deviceCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

const stepSchema = new Schema({ text: String, waitFor: { type: String, enum: ['response', 'timer'] }, delaySeconds: Number }, { _id: false });
// Optional chain settings (intake facts, success-criteria step); validated by the shared schema first.
const chainSchema = new Schema({ type: { type: String, enum: ['planning', 'general'] }, intake: { type: [String], default: undefined }, successCriteria: Boolean }, { _id: false });
const variableSchema = new Schema({ name: String, description: String, default: String }, { _id: false });
const promptFields = {
  slug: { type: String, required: true },
  title: { type: String, required: true },
  category: { type: String, required: true },
  tags: [String],
  description: { type: String, default: '' },
  scope: { type: String, enum: ['personal', 'team'], required: true },
  variables: [variableSchema],
  steps: [stepSchema],
  chain: { type: chainSchema, default: undefined },
  body: { type: String, default: '' },
};
const promptSchema = new Schema(
  {
    ...promptFields,
    ownerId: { type: id, ref: 'User', required: true, index: true },
    teamId: { type: id, ref: 'Team', index: true }, // set for team prompts
    version: { type: Number, default: 1 },
    updatedBy: { type: id, ref: 'User' },
  },
  { timestamps: true },
);
// One prompt per slug within a scope: per owner for personal, per team for team prompts.
promptSchema.index({ scope: 1, ownerId: 1, category: 1, slug: 1 }, { unique: true, partialFilterExpression: { scope: 'personal' } });
promptSchema.index({ scope: 1, teamId: 1, category: 1, slug: 1 }, { unique: true, partialFilterExpression: { scope: 'team' } });

const promptVersionSchema = new Schema(
  {
    promptId: { type: id, ref: 'Prompt', required: true, index: true },
    version: { type: Number, required: true },
    snapshot: { type: new Schema(promptFields, { _id: false }), required: true },
    editedBy: { type: id, ref: 'User' },
  },
  { timestamps: true },
);

const num = { type: Number, min: 0 };
const usageSchema = new Schema(
  {
    userId: { type: id, ref: 'User', required: true },
    teamId: { type: id, ref: 'Team', index: true },
    user: { type: String, maxlength: 200 }, // the client's user label (display only)
    project: { type: String, required: true, maxlength: 300 },
    sessionId: { type: String, required: true, maxlength: 200 },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    source: { type: String, enum: ['cli', 'plugin', 'queue', 'extension'], required: true },
    model: { type: String, maxlength: 200 },
    inputTokens: num, outputTokens: num, cacheReadTokens: num, cacheCreationTokens: num,
    costUsd: num, messages: num, estimatedTokens: num, durationMs: num,
    processedTokensLow: num, processedTokensHigh: num, // extension only: estimated range
  },
  { timestamps: true },
);
// Re-syncing the same record replaces it (no double counting).
usageSchema.index({ userId: 1, source: 1, sessionId: 1, date: 1 }, { unique: true });
usageSchema.index({ teamId: 1, date: 1 });

const queueReportSchema = new Schema(
  {
    userId: { type: id, ref: 'User', required: true },
    teamId: { type: id, ref: 'Team', index: true },
    taskId: { type: String, required: true, maxlength: 100 },
    title: { type: String, required: true, maxlength: 200 },
    status: { type: String, enum: ['done', 'failed', 'waiting-for-reset'], required: true },
    summary: { type: String, maxlength: 4000, default: '' },
    branch: { type: String, maxlength: 200 },
    filesChanged: [{ type: String, maxlength: 500 }],
    testsRun: { type: String, maxlength: 500 },
    startedAt: Date,
    finishedAt: Date,
  },
  { timestamps: true },
);
queueReportSchema.index({ userId: 1, taskId: 1 }, { unique: true });

const sharedItemSchema = new Schema(
  {
    userId: { type: id, ref: 'User', required: true },
    teamId: { type: id, ref: 'Team', required: true, index: true },
    kind: { type: String, enum: ['passport', 'summary', 'tree'], required: true },
    title: { type: String, required: true, maxlength: 200 },
    content: { type: String, required: true, maxlength: 100_000 },
    project: { type: String, maxlength: 300 },
  },
  { timestamps: true },
);

// Team Decision Ledger entries (only for teams with ledgerSync on; scrubbed by the client and again here).
const decisionSchema = new Schema(
  {
    teamId: { type: id, ref: 'Team', required: true, index: true },
    userId: { type: id, ref: 'User', required: true }, // who last uploaded it
    clientId: { type: String, required: true, maxlength: 80 },
    text: { type: String, required: true, maxlength: 1000 },
    reason: { type: String, maxlength: 2000, default: '' },
    author: { type: String, maxlength: 200, default: '' },
    project: { type: String, maxlength: 300, default: '' },
    sourceChat: { type: String, maxlength: 1000, default: '' },
    status: { type: String, enum: ['active', 'superseded', 'pending'], required: true },
    supersededBy: { type: String, maxlength: 80, default: null },
    supersedes: { type: String, maxlength: 80, default: null },
    tags: [{ type: String, maxlength: 60 }],
    confirmed: { type: Boolean, default: true },
    decidedAt: { type: String, maxlength: 40 }, // the client's createdAt
    clientUpdatedAt: { type: String, maxlength: 40 },
  },
  { timestamps: true },
);
decisionSchema.index({ teamId: 1, clientId: 1 }, { unique: true });

export const User = mongoose.models.User ?? mongoose.model('User', userSchema);
export const Team = mongoose.models.Team ?? mongoose.model('Team', teamSchema);
export const Invite = mongoose.models.Invite ?? mongoose.model('Invite', inviteSchema);
export const Token = mongoose.models.Token ?? mongoose.model('Token', tokenSchema);
export const DeviceCode = mongoose.models.DeviceCode ?? mongoose.model('DeviceCode', deviceCodeSchema);
export const Prompt = mongoose.models.Prompt ?? mongoose.model('Prompt', promptSchema);
export const PromptVersion = mongoose.models.PromptVersion ?? mongoose.model('PromptVersion', promptVersionSchema);
export const UsageRecord = mongoose.models.UsageRecord ?? mongoose.model('UsageRecord', usageSchema);
export const QueueReport = mongoose.models.QueueReport ?? mongoose.model('QueueReport', queueReportSchema);
export const SharedItem = mongoose.models.SharedItem ?? mongoose.model('SharedItem', sharedItemSchema);
export const Decision = mongoose.models.Decision ?? mongoose.model('Decision', decisionSchema);
