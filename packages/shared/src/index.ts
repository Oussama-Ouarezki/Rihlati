/**
 * @rihlati/shared — the contract between the API and every client.
 *
 * Nothing in here may import from the API, the database client, React, or any
 * runtime-specific library. It must stay usable from Node, the browser, and
 * React Native alike. `zod` is the only dependency.
 */

export * from './enums';
export * from './errors';
export * from './validation-messages';
export * from './plans';
export * from './money';
export * from './phone';
export * from './wilayas';
export * from './pagination';
export * from './analytics';
export * from './auth/schemas';
export * from './auth/oauth';
export * from './agencies/schemas';
export * from './offers/attributes';
export * from './offers/schemas';
export * from './offers/form-fields';
export * from './offers/responses';
export * from './offers/reports';
export * from './offers/dedup';
export * from './leads/schemas';
export * from './reservations/schemas';
export * from './tracked-links/schemas';
export * from './milestones/schemas';
export * from './trips/schemas';
