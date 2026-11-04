import { expect, test } from "bun:test";
import {
  matchesIpRule,
  parseIpList,
  evaluateIpFilter,
} from "../src/firewall.js";

test("IPv6 compressed and expanded exact addresses are equivalent", () => {
  expect(matchesIpRule("2001:db8::1234", "2001:0db8:0:0:0:0:0:1234")).toBe(
    true,
  );
  expect(matchesIpRule("2001:db8::1234", "2001:db8::1235")).toBe(false);
  expect(matchesIpRule("0:0:0:0:0:0:0:1", "::1")).toBe(true);
});
test("IPv6 subnet boundaries are enforced", () => {
  expect(matchesIpRule("2001:db8:1:2::1", "2001:db8:1:2::/64")).toBe(true);
  expect(matchesIpRule("2001:db8:1:3::1", "2001:db8:1:2::/64")).toBe(false);
  expect(matchesIpRule("2001:db8::1", "2001:db8::1/128")).toBe(true);
  expect(matchesIpRule("2001:db8::2", "2001:db8::1/128")).toBe(false);
});
test("IPv4-mapped addresses work on either side of a rule", () => {
  expect(matchesIpRule("192.0.2.10", "::ffff:192.0.2.10")).toBe(true);
  expect(matchesIpRule("::ffff:c000:20a", "192.0.2.10")).toBe(true);
  expect(matchesIpRule("192.0.2.10", "::ffff:192.0.2.0/120")).toBe(true);
  expect(matchesIpRule("::ffff:192.0.2.10", "192.0.2.0/24")).toBe(true);
});
test("invalid firewall rules fail configuration rather than being ignored", () => {
  for (const rule of [
    "garbage",
    "1.2.3.4/",
    "1.2.3.4/33",
    "::1/129",
    "::1/-1",
    "::1/1/2",
    "1.2.3.4/1e1",
  ]) {
    expect(() => parseIpList(rule)).toThrow();
    expect(matchesIpRule("1.2.3.4", rule)).toBe(false);
  }
});
test("IPv6 blocklist takes priority and invalid clients fail closed", () => {
  expect(
    evaluateIpFilter("2001:db8::1", {
      allowlist: ["2001:db8::/32"],
      blocklist: ["2001:db8::1"],
    }).allowed,
  ).toBe(false);
  expect(evaluateIpFilter("invalid", { blocklist: ["192.0.2.1"] }).reason).toBe(
    "invalid_ip",
  );
  expect(
    evaluateIpFilter("192.0.2.10", { blocklist: ["::ffff:192.0.2.10"] })
      .allowed,
  ).toBe(false);
});
