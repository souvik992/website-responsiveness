import { devices } from '@playwright/test';

export type BrowserEngine = 'chromium' | 'webkit' | 'firefox';
export type DeviceDescriptor = (typeof devices)[string];

export interface DeviceCase {
  kind: 'device';
  /** Unique test id, also used in screenshot filenames. */
  id: string;
  deviceName: string;
  browserType: BrowserEngine;
  viewport: { width: number; height: number };
  category: 'mobile' | 'tablet' | 'landscape';
  /** Full Playwright device descriptor (userAgent, deviceScaleFactor, isMobile, hasTouch, ...) for realistic emulation. */
  deviceDescriptor: DeviceDescriptor;
}

export interface BreakpointCase {
  kind: 'breakpoint';
  id: string;
  width: number;
  height: number;
  browserType: BrowserEngine;
}

export type ResponsiveTestCase = DeviceCase | BreakpointCase;

// Full raw list of every device descriptor Playwright ships with this
// installed version — never hand-typed, so the matrix grows automatically
// as Playwright adds devices.
export const allDeviceNames = Object.keys(devices);

export const mobileDeviceNames = allDeviceNames.filter((name) => {
  const d = devices[name];
  return d.isMobile && d.hasTouch && d.viewport.width < 600 && !name.includes('landscape');
});

export const tabletDeviceNames = allDeviceNames.filter((name) => {
  const d = devices[name];
  return d.hasTouch && d.viewport.width >= 600 && d.viewport.width < 1100 && !name.includes('landscape');
});

export const landscapeDeviceNames = allDeviceNames.filter((name) => name.includes('landscape'));

export const desktopDeviceNames = allDeviceNames.filter((name) => {
  const d = devices[name];
  return !d.isMobile && !d.hasTouch;
});

function categoryFor(name: string): DeviceCase['category'] {
  if (landscapeDeviceNames.includes(name)) return 'landscape';
  if (tabletDeviceNames.includes(name)) return 'tablet';
  return 'mobile';
}

function slugify(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
}

const CUSTOM_BREAKPOINT_WIDTHS = [320, 375, 480, 600, 768, 900, 1024, 1280, 1440];
const CUSTOM_BREAKPOINT_HEIGHT = 900;
const BREAKPOINT_ENGINES: BrowserEngine[] = ['chromium', 'webkit', 'firefox'];

/**
 * Named device descriptors, each run once on its own pinned engine
 * (mobileDevices + tabletDevices + landscapeVariants), plus fixed-width
 * breakpoints run across all three engines to catch engine-specific
 * rendering differences at the same viewport size.
 */
export function buildResponsiveTestMatrix(): ResponsiveTestCase[] {
  const deviceCases: DeviceCase[] = [...mobileDeviceNames, ...tabletDeviceNames, ...landscapeDeviceNames].map(
    (deviceName) => {
      const d = devices[deviceName];
      return {
        kind: 'device',
        id: `device__${slugify(deviceName)}`,
        deviceName,
        browserType: d.defaultBrowserType as BrowserEngine,
        viewport: d.viewport,
        category: categoryFor(deviceName),
        deviceDescriptor: d,
      };
    }
  );

  const breakpointCases: BreakpointCase[] = CUSTOM_BREAKPOINT_WIDTHS.flatMap((width) =>
    BREAKPOINT_ENGINES.map((browserType) => ({
      kind: 'breakpoint' as const,
      id: `breakpoint__${width}x${CUSTOM_BREAKPOINT_HEIGHT}__${browserType}`,
      width,
      height: CUSTOM_BREAKPOINT_HEIGHT,
      browserType,
    }))
  );

  return [...deviceCases, ...breakpointCases];
}
