export interface CompanyFeatures {
  /** Collection MIS pages. */
  misReports: boolean;
  /** "Email a report", recipient lists and scheduled MIS emails. */
  reportEmails: boolean;
}

export type FeatureKey = keyof CompanyFeatures;

export const NO_FEATURES: CompanyFeatures = { misReports: false, reportEmails: false };
