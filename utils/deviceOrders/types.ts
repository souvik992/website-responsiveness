export type OrderStatus = 'PASS' | 'FAIL';
export type CompatibilityStatus = 'PASS' | 'WARNING' | 'FAIL';

export interface DeviceOrderResult {
  device: string;
  browser: string;
  resolution: string;
  category: 'mobile' | 'tablet' | 'landscape' | 'desktop';

  orderStatus: OrderStatus;
  orderId: string;
  orderNumber: string;
  paymentMethod: string;
  failedStep: string;
  orderError: string;

  compatibilityStatus: CompatibilityStatus;
  compatibilityIssueType: string;
  compatibilityIssueDescription: string;

  durationMs: number;
  screenshotDir: string;
}
