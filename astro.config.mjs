import { defineConfig } from 'astro/config';

// GitHub Pages project sites serve under /<repo>; user/org *.github.io repos serve at the root.
// CI sets GITHUB_REPOSITORY=owner/repo — derive the base from it; plain '/' locally.
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
const base = !repo || repo.endsWith('.github.io') ? '/' : `/${repo}`;

export default defineConfig({ base });
