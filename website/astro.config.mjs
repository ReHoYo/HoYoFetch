import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const projectBase = "/HoYoFetch";

export default defineConfig({
  site: "https://rehoyo.github.io",
  base: projectBase,
  integrations: [
    starlight({
      title: "Irminsul Docs",
      description:
        "The complete command, setup, moderation, audit-log, automod, and self-hosting guide for Irminsul.",
      logo: {
        src: "./src/assets/irminsul-logo.png",
        alt: "Irminsul logo",
      },
      favicon: "/favicon.png",
      customCss: ["./src/styles/custom.css"],
      editLink: {
        baseUrl: "https://github.com/ReHoYo/HoYoFetch/edit/main/website/",
      },
      social: [
        {
          icon: "github",
          label: "Irminsul on GitHub",
          href: "https://github.com/ReHoYo/HoYoFetch",
        },
      ],
      head: [
        {
          tag: "meta",
          attrs: { name: "theme-color", content: "#111827" },
        },
        {
          tag: "meta",
          attrs: { property: "og:type", content: "website" },
        },
      ],
      sidebar: [
        {
          label: "Start here",
          items: [
            { slug: "getting-started" },
            { slug: "commands" },
            { slug: "permissions" },
          ],
        },
        {
          label: "Codes and setup",
          items: [
            { slug: "codes/auto-fetch" },
            { slug: "codes/custom-emoji" },
            { slug: "codes/sources" },
          ],
        },
        {
          label: "Moderation",
          items: [
            { slug: "moderation/overview" },
            { slug: "moderation/manual-actions" },
            { slug: "moderation/audit-log" },
            { slug: "moderation/automod" },
          ],
        },
        {
          label: "Help and administration",
          items: [
            { slug: "troubleshooting" },
            { slug: "administration/configuration" },
            { slug: "administration/data-and-privacy" },
            { slug: "administration/self-hosting" },
            { slug: "administration/architecture" },
            { slug: "changelog" },
          ],
        },
      ],
    }),
  ],
});
