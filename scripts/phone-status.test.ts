import { expect, test } from "bun:test";
import { setPhoneState, waitForPhone } from "../src/lib/telephony/phone-status";

test("no browser phone, or a ready one: dial at once", async () => {
  setPhoneState("none");
  expect(await waitForPhone(10)).toBe(true);
  setPhoneState("ready");
  expect(await waitForPhone(10)).toBe(true);
});

test("connecting: waits until ready, or gives up after the time", async () => {
  setPhoneState("connecting");
  const waiting = waitForPhone(1000);
  setTimeout(() => setPhoneState("ready"), 20);
  expect(await waiting).toBe(true);
  setPhoneState("connecting");
  expect(await waitForPhone(30)).toBe(false);
  setPhoneState("none");
});
