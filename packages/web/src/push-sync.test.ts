import { describe, expect, it } from "vitest";
import { dashboardShowsIt } from "./push-sync.ts";

const android = "https://fcm.googleapis.com/fcm/send/abc";
const iphone = "https://web.push.apple.com/abc";
const inFront = { visibilityState: "visible" as const, focused: true };
const behind = { visibilityState: "hidden" as const, focused: false };

describe("dashboardShowsIt", () => {
	it("holds a notification back while the dashboard is on screen and in front", () => {
		expect(dashboardShowsIt([behind, inFront], android)).toBe(true);
	});

	it("shows it when the dashboard is closed, in the background or not focused", () => {
		expect(dashboardShowsIt([], android)).toBe(false);
		expect(dashboardShowsIt([behind], android)).toBe(false);
		expect(dashboardShowsIt([{ visibilityState: "visible", focused: false }], android)).toBe(false);
	});

	it("always shows it on an iPhone, which cancels pushes that show nothing", () => {
		expect(dashboardShowsIt([inFront], iphone)).toBe(false);
		expect(dashboardShowsIt([inFront], undefined)).toBe(false);
	});
});
