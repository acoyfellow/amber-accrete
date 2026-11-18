import { describe, expect, it } from "vitest";
import { decideClose, OPEN } from "./issue";

describe("Issue: closing an issue", () => {
	it("closes an open issue a person approved", () => {
		expect(decideClose("101", OPEN, "run-a", true)).toEqual({ accepted: true, state: { open: false, closedBy: "run-a" } });
	});

	it("refuses an issue someone else already closed, and says who", () => {
		const closed = { open: false, closedBy: "someone-else" };
		expect(decideClose("101", closed, "run-a", true)).toEqual({ accepted: false, rejection: "AlreadyClosed", detail: { by: "someone-else" } });
	});

	it("refuses to close without a person's approval", () => {
		expect(decideClose("101", OPEN, "run-a", false)).toEqual({ accepted: false, rejection: "NotApproved", detail: {} });
	});

	it("checks the issue is still open before checking approval", () => {
		const closed = { open: false, closedBy: "someone-else" };
		expect(decideClose("101", closed, "run-a", false)).toMatchObject({ rejection: "AlreadyClosed" });
	});
});
