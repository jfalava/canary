import * as Schema from "effect/Schema";

// Operators must generate random 256-bit credentials. Syntax alone cannot
// establish entropy; retain support for existing independently generated tokens.
export const Token = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{32,512}$(?![\s\S])/));

// ASCII dot-atom mailboxes, not display names, address lists, or SMTPUTF8.
const Mailbox = Schema.String.check(
  Schema.isMaxLength(254),
  Schema.isPattern(
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$(?![\s\S])/,
  ),
  Schema.makeFilter((value) => value.slice(0, value.indexOf("@")).length <= 64),
);
const mailboxIdentity = (value: string) => {
  const at = value.lastIndexOf("@");
  return value.slice(0, at) + value.slice(at).toLowerCase();
};

// Each credentials/<sha256(token)> record is the complete delivery policy.
// Cloudflare enforces sending-domain authorization when the email is sent.
export const CredentialRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  enabled: Schema.Boolean,
  sender: Mailbox,
  recipient: Schema.Array(Mailbox).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(50),
    Schema.makeFilter((values) => new Set(values.map(mailboxIdentity)).size === values.length),
  ),
  name: Schema.optional(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(100),
      // oxlint-disable-next-line no-control-regex -- Operator labels must not inject log/header lines.
      Schema.isPattern(/^[^\x00-\x1f\x7f-\x9f]+$(?![\s\S])/),
    ),
  ),
});
export const decodeCredentialRecord = Schema.decodeUnknownSync(CredentialRecord, {
  onExcessProperty: "error",
});

const validTimestamp = (value: string): boolean => {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  const days = new Date(`${year}-${month}-01T00:00:00Z`);
  days.setUTCMonth(days.getUTCMonth() + 1);
  days.setUTCDate(0);
  return (
    Number(month) >= 1 &&
    Number(month) <= 12 &&
    Number(day) >= 1 &&
    Number(day) <= days.getUTCDate() &&
    Number(hour) < 24 &&
    Number(minute) < 60 &&
    Number(second) < 60 &&
    (zone === "Z" || (Number(zone!.slice(1, 3)) < 24 && Number(zone!.slice(4)) < 60)) &&
    Number.isFinite(Date.parse(value))
  );
};

// Bound pretty-print expansion and recursion independently of wire byte limits.
const validMetadata = (value: unknown, depth = 1): boolean => {
  if (typeof value === "number") return Number.isFinite(value);
  if (value === null || typeof value !== "object") return true;
  return depth <= 20 && Object.values(value).every((child) => validMetadata(child, depth + 1));
};

export const AlertRequest = Schema.Struct({
  title: Schema.String.check(
    Schema.makeFilter((value) => value.trim().length > 0 && value.trim().length <= 200),
    // oxlint-disable-next-line no-control-regex -- Reject email subject control/header injection.
    Schema.isPattern(/^[^\x00-\x1f\x7f-\x9f]*$(?![\s\S])/),
  ),
  message: Schema.String.check(
    Schema.isMaxLength(12_000),
    Schema.makeFilter((value) => value.trim().length > 0 && !value.includes("\0")),
  ),
  timestamp: Schema.optional(Schema.String.check(Schema.makeFilter(validTimestamp))),
  metadata: Schema.optional(
    Schema.Record(Schema.String, Schema.Unknown).check(
      Schema.makeFilter((value) => validMetadata(value)),
    ),
  ),
});
export const decodeAlertRequest = Schema.decodeUnknownSync(AlertRequest, {
  onExcessProperty: "error",
});
