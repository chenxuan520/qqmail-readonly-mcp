import assert from "node:assert/strict";
import { decodeHeaderWords } from "../src/mail/mime.ts";

assert.equal(decodeHeaderWords("=?UTF-8?B?Q2Fmw6kgVXBkYXRl?="), "Café Update");
assert.equal(decodeHeaderWords("=?UTF-8?Q?Caf=C3=A9_Update?="), "Café Update");
assert.equal(decodeHeaderWords("=?UTF-8?B?Q2Fmw6k=?= =?UTF-8?B?IFVwZGF0ZQ==?="), "Café Update");
assert.equal(decodeHeaderWords("=?GB2312?B?1tDOxA==?="), "中文");
assert.equal(decodeHeaderWords("plain subject"), "plain subject");
