import React from "react";
import { LegalDoc, LegalSection } from "@/src/legal";

// Generated from the canonical policy (legal/privacy.md). Keep website/privacy.html,
// legal_site/privacy and memory/privacy_policy.md in sync.
const UPDATED = "4 November 2026";

const INTRO =
  "Drivers Gig Tax (\"Drivers Gig Tax\", \"GigTax\", \"we\", \"us\") is operated by [TO CONFIRM: legal entity name], ABN [TO CONFIRM], [TO CONFIRM: postal address], South Australia. This policy explains how we handle personal information under the Privacy Act 1988 (Cth) and the Australian Privacy Principles (APPs). Contact: support@driversgigtax.app · https://driversgigtax.app/privacy";

const SECTIONS: LegalSection[] = [
  {
    "heading": "What we collect",
    "body": [
      "• Account: name, email and profile picture from Google Sign-In; Apple user identifier and (possibly private-relay) email from Sign in with Apple.",
      "• Profile and tax settings: driver/legal or business name, region, gig platforms used, tax settings including a yes/no flag that you have a tax ID on file. We do not ask for or store your TFN or ABN number. Please do not enter your TFN anywhere in the app (including receipts, notes or the Ask assistant).",
      "• Vehicle: registration, make/model, purchase price, finance details, odometer readings.",
      "• Trips: date, distance, start/end times and labels you type. Distance is calculated on your device; raw GPS coordinates are not uploaded to our servers.",
      "• Financial records: income, expenses, GST figures, shifts, Uber Eats jobs and receipt photos (stored on our servers).",
      "• Ask questions and voice input: questions you type in Ask, and Uber Eats jobs you dictate. Dictation uses your device's speech service (Google speech services on Android, Apple speech recognition on iOS); we keep only the resulting text.",
      "• Subscription status (via Apple, Google Play and RevenueCat). We never receive card details. We do not collect bank account data and we do not use analytics or advertising SDKs.",
      "• Trial record: to stop repeat free trials, we keep a one-way hash (SHA-256) of your sign-in email or Apple ID. It cannot be turned back into your email and is kept after account deletion (see section 9)."
    ]
  },
  {
    "heading": "Device permissions",
    "body": [
      "• Location, including background location: optional. Before asking for it, the app shows a notice explaining that Drivers Gig Tax collects location data to detect drives automatically and to record your mileage logbook, even when the app is closed or not in use. If you turn on \"Detect drives automatically\" or start a drive, the app uses location in the background (with an ongoing notification on Android) until you turn it off in the app or in your device settings. Location is processed on your phone only to calculate distance; we store trip distance and times, not your GPS route. It is never used for advertising and never sold. If you decline, you can still log trips manually or track a drive with the app open.",
      "• Camera and photos: optional, to capture or choose receipts. On Android the app uses the system photo picker and does not request access to your whole photo library.",
      "• Microphone and speech recognition: optional, used only while you tap voice input to speak your Uber Eats jobs. Audio is processed by your device's speech service and we receive only the text. The app does not record audio for any other purpose."
    ]
  },
  {
    "heading": "How we use it",
    "body": [
      "To provide record-keeping, logbook, tax estimates and reports; scan receipts; answer Ask questions; back up to your Google Drive if you choose; manage your trial and subscription; provide support; and keep the service working and secure. We do not sell personal information or use it for direct marketing without consent."
    ]
  },
  {
    "heading": "Automated processing and AI",
    "body": [
      "The app uses software, including AI (Anthropic Claude), to extract receipt details, categorise expenses and estimate tax and set-aside amounts from the information you enter. These outputs are estimates for your information; we do not use them to make decisions about you (e.g. eligibility, pricing or account access). [LEGAL REVIEW: confirm whether any APP 1.7–1.8 automated-decision disclosure is required from 10 Dec 2026; if so list the kinds of personal information used and decisions made.] AI output can be wrong — always check it."
    ]
  },
  {
    "heading": "Service providers we use",
    "body": [
      "We disclose information to these providers only so they can run the service for us:",
      "• Anthropic, PBC (United States) — receipt images and Ask questions (with up to 6 previous chat turns) to generate results. We do not send your name, email or user ID. Under Anthropic's commercial API terms, inputs and outputs are not used to train its models by default. [LEGAL REVIEW: confirm the Anthropic data-retention terms that apply to our account.]",
      "• Supabase (database hosting, Sydney region, ap-southeast-2) — stores your account and records.",
      "• Fly.io (API hosting, Sydney region; Fly.io is a US company).",
      "• Google — Google Sign-In, optional Google Drive backup, Android speech recognition for voice input, and Google Play billing.",
      "• Apple — Sign in with Apple, iOS speech recognition for voice input, and App Store billing.",
      "• RevenueCat, Inc. (United States) — an internal app user ID and purchase status to manage subscriptions.",
      "• Authorities, where required or authorised by law."
    ]
  },
  {
    "heading": "Overseas disclosure (APP 8)",
    "body": [
      "Some providers are located in, or may access data from, the United States (Anthropic, RevenueCat, and potentially Google, Apple, Supabase and Fly.io for support and operations). Your main records are hosted in Sydney. We take reasonable steps (contractual terms and minimising what we send) so these providers handle information consistently with the APPs. [LEGAL REVIEW: confirm the APP 8.1 position and wording.]"
    ]
  },
  {
    "heading": "Google user data",
    "body": [
      "Drive access uses the limited drive.file scope (only files the app creates). Our use of information from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. Drive tokens are stored encrypted."
    ]
  },
  {
    "heading": "Security",
    "body": [
      "We use encrypted connections (HTTPS) and access controls and are working to improve our safeguards. No system is completely secure. If an eligible data breach occurs we will notify affected users and the OAIC as required by the Notifiable Data Breaches scheme."
    ]
  },
  {
    "heading": "Retention and deletion",
    "body": [
      "We keep your records while your account is active (tax records may be useful for 5 years; keeping your own copies is your responsibility). Login sessions expire after 7 days; demo accounts are deleted after 2 days.",
      "You can delete your account in two ways:",
      "• In the app: Profile › Delete account › Delete permanently. Deletion is immediate.",
      "• Without the app: email support@driversgigtax.app from your sign-in email (or follow https://driversgigtax.app/delete-account). We complete email and web requests within 30 days.",
      "Deletion removes your profile, vehicles, trips, income, expenses and receipt images, shifts, Uber Eats jobs, login sessions, Google Drive connection tokens (we also revoke Drive access) and your user record. It does not delete: the hashed trial record described in section 1; backups in your own Google Drive (delete those yourself); your subscription (cancel through Apple or Google); records Apple, Google and RevenueCat keep under their own policies; or website waitlist sign-ups (ask us and we will remove them). Database backups at our host roll off on the provider's schedule. [TO CONFIRM: Supabase backup retention period for our plan.]"
    ]
  },
  {
    "heading": "Access, correction and complaints",
    "body": [
      "You can access and correct most information in the app, or ask us at support@driversgigtax.app; we respond within 30 days. If you are not satisfied with our response to a complaint, you can contact the Office of the Australian Information Commissioner (oaic.gov.au, 1300 363 992)."
    ]
  },
  {
    "heading": "Children",
    "body": [
      "The service is for adults 18+ and is not directed at children."
    ]
  },
  {
    "heading": "Changes",
    "body": [
      "We will update the date above and notify you in the app of material changes."
    ]
  }
];

export default function Privacy() {
  return <LegalDoc title="Privacy Policy" updated={UPDATED} intro={INTRO} sections={SECTIONS} testIDPrefix="privacy" />;
}
