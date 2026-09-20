import React from "react";
import { LegalDoc, LegalSection } from "@/src/legal";

const UPDATED = "19 June 2026";

const INTRO =
  "These Terms of Service (\u201CTerms\u201D) govern your use of the GigTax mobile application, operated by Global Apps AI (\u201Cwe\u201D, \u201Cus\u201D, \u201Cour\u201D). By downloading or using GigTax you agree to these Terms. If you do not agree, please do not use the app.";

const SECTIONS: LegalSection[] = [
  {
    heading: "The service",
    body: [
      "GigTax helps gig-economy drivers record income, expenses and mileage and provides estimated tax figures and reports based on the information you enter and general tax rules.",
    ],
  },
  {
    heading: "Not tax or financial advice",
    body: [
      "GigTax provides estimates and general information to help you plan. It is not tax, accounting, legal or financial advice, and it is not a substitute for a registered tax professional.",
      "Your actual tax obligations depend on your complete records and your country\u2019s tax laws. Always confirm your figures with a qualified tax agent or accountant before you lodge or file. You are responsible for the accuracy of the information you enter and for your own tax filings.",
    ],
  },
  {
    heading: "Eligibility and accounts",
    body: [
      "You must be at least 16 years old and able to enter a binding contract to use GigTax.",
      "You are responsible for keeping your account secure and for all activity that occurs under it. Sign-in is provided through Google; you must comply with Google\u2019s terms as well.",
    ],
  },
  {
    heading: "Subscriptions and billing",
    body: [
      "GigTax may be offered on a subscription basis, including a free trial. Subscriptions are billed through the Apple App Store or Google Play according to the plan you select.",
      "Unless cancelled, subscriptions renew automatically at the end of each period. You can manage or cancel your subscription in your App Store or Google Play account settings; cancellation takes effect at the end of the current billing period.",
      "Except where required by law or store policy, payments are non-refundable. Prices may change; we will give notice as required by the app stores.",
    ],
  },
  {
    heading: "Acceptable use",
    body: [
      "You agree to use GigTax only for lawful purposes and not to misuse, reverse-engineer, disrupt, or attempt to gain unauthorised access to the app or its systems, or to use it in a way that infringes the rights of others.",
    ],
  },
  {
    heading: "Your content and data",
    body: [
      "You retain ownership of the records and images you enter. You grant us the limited right to store and process this content to provide the app\u2019s features, including backups to your own Google Drive if you enable them. Our handling of your data is described in our Privacy Policy.",
    ],
  },
  {
    heading: "Intellectual property",
    body: [
      "GigTax, including its software, design and content (excluding your data), is owned by Global Apps AI and protected by intellectual-property laws. We grant you a personal, non-exclusive, non-transferable licence to use the app in accordance with these Terms.",
    ],
  },
  {
    heading: "Disclaimers",
    body: [
      "GigTax is provided \u201Cas is\u201D and \u201Cas available\u201D without warranties of any kind, to the maximum extent permitted by law. We do not warrant that the app will be uninterrupted, error-free, or that estimates will match your final tax outcome.",
    ],
  },
  {
    heading: "Limitation of liability",
    body: [
      "To the maximum extent permitted by law, Global Apps AI will not be liable for any indirect, incidental, special or consequential damages, or for any loss arising from your reliance on estimates, tax outcomes, lost data or lost profits. Nothing in these Terms limits rights that cannot be excluded under applicable consumer law.",
    ],
  },
  {
    heading: "Termination",
    body: [
      "You may stop using GigTax and delete your account at any time from Profile \u203A Delete account. We may suspend or terminate access if you breach these Terms or misuse the service.",
    ],
  },
  {
    heading: "Changes to these Terms",
    body: [
      "We may update these Terms from time to time. If we make material changes we will update the \u201CLast updated\u201D date above and, where appropriate, notify you in the app. Continued use after changes means you accept the updated Terms.",
    ],
  },
  {
    heading: "Contact us",
    body: [
      "Questions about these Terms can be sent to globalappsai@gmail.com.",
    ],
  },
];

export default function Terms() {
  return <LegalDoc title="Terms of Service" updated={UPDATED} intro={INTRO} sections={SECTIONS} testIDPrefix="terms" />;
}
