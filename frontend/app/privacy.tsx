import React from "react";
import { LegalDoc, LegalSection } from "@/src/legal";

const UPDATED = "19 June 2026";

const INTRO =
  "GigTax (\u201Cwe\u201D, \u201Cus\u201D, \u201Cour\u201D), operated by Global Apps AI, helps gig-economy drivers track income, expenses and mileage and estimate their tax. This Privacy Policy explains what information we collect, how we use it, and the choices you have. By using GigTax you agree to this policy.";

const SECTIONS: LegalSection[] = [
  {
    heading: "Information you provide",
    body: [
      "Account details: when you sign in with Google we receive your name, email address and profile picture so we can create and secure your account.",
      "Financial records you enter: income, expenses, receipts, vehicle details, odometer readings, work hours and shift information.",
      "Support messages: any information you send us by email.",
    ],
  },
  {
    heading: "Location information",
    body: [
      "If you enable GPS trip tracking or automatic drive detection, GigTax collects your device\u2019s location while a drive is being recorded \u2014 including in the background \u2014 solely to calculate the distance of your work trips for your mileage log.",
      "Location is only used to measure trip distance. We do not use it for advertising and we do not sell it. You can turn tracking off at any time in your device settings or in the app.",
    ],
  },
  {
    heading: "Receipt images and AI scanning",
    body: [
      "When you scan a receipt, the image is sent securely to our AI provider (OpenAI) to extract details such as amount, date and supplier. The image and extracted data are stored with your account so you can review them.",
    ],
  },
  {
    heading: "Google Drive backups and Google user data",
    body: [
      "If you connect Google Drive, GigTax uses the restricted \u201Cdrive.file\u201D scope, which lets the app create and manage only the backup files it creates in your Drive. We cannot see or access any other files in your Google Drive.",
      "GigTax\u2019s use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. We do not use Google user data for advertising and we do not sell it.",
    ],
  },
  {
    heading: "How we use your information",
    body: [
      "To provide the app\u2019s core features: recording your income, expenses and mileage and generating tax estimates and reports.",
      "To authenticate you, sync your data across your devices, and back up your data to your own Google Drive at your request.",
      "To operate, maintain, secure and improve the app, and to respond to your support requests.",
    ],
  },
  {
    heading: "How your information is shared",
    body: [
      "We do not sell your personal information.",
      "We share data only with service providers that help us run the app: Google (sign-in and, if you enable it, Drive backup), OpenAI (receipt scanning and the tax assistant), and, if applicable, our subscription provider for processing in-app purchases. These providers process data on our behalf under their own terms.",
      "We may disclose information if required by law or to protect the rights, safety and security of our users and the service.",
    ],
  },
  {
    heading: "Data storage and security",
    body: [
      "Your records are stored on secure servers. We use reasonable technical and organisational measures to protect your information. No method of transmission or storage is completely secure, so we cannot guarantee absolute security.",
    ],
  },
  {
    heading: "Data retention and deletion",
    body: [
      "We keep your information for as long as your account is active. You can permanently delete your account and all associated data at any time from Profile \u203A Delete account. Deletion is immediate and cannot be undone.",
      "You may also disconnect Google Drive at any time from Profile \u203A Backups, which stops future backups.",
    ],
  },
  {
    heading: "Your rights",
    body: [
      "Depending on where you live, you may have the right to access, correct, export or delete your personal information. You can exercise most of these directly in the app, or by contacting us at globalappsai@gmail.com.",
    ],
  },
  {
    heading: "Children",
    body: [
      "GigTax is intended for adults who work as gig-economy drivers and is not directed at children under 16. We do not knowingly collect personal information from children.",
    ],
  },
  {
    heading: "Changes to this policy",
    body: [
      "We may update this Privacy Policy from time to time. If we make material changes we will update the \u201CLast updated\u201D date above and, where appropriate, notify you in the app.",
    ],
  },
  {
    heading: "Contact us",
    body: [
      "If you have any questions about this Privacy Policy or your data, contact us at globalappsai@gmail.com.",
    ],
  },
];

export default function Privacy() {
  return <LegalDoc title="Privacy Policy" updated={UPDATED} intro={INTRO} sections={SECTIONS} testIDPrefix="privacy" />;
}
