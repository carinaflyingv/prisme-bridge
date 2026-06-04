# Prisme Bridge

Exports Figma native variable JSON files to Token Studio JSON format. No Token Studio plugin needed.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## First time setup

1. Copy the `prisme-bridge` folder to your Desktop
2. Run `npm install`
3. Export variables from Figma — **File > Resources > Export variables**
4. Drop the JSON files into the `tokens/` folder
5. Run `node src/exporter.js --init` and answer the setup questions
6. Run `node src/exporter.js --all`
7. Find your Token Studio JSON files in the `export/` folder

---

## Every time after

1. Export fresh variables from Figma
2. Drop into `tokens/` folder
3. Run `node src/exporter.js --all`
4. Find files in `export/` folder

---

## Built with

Claude Code and Figma MCP

---

## The cats behind the system

Every segment mode is named after a cat:

| Name | Vibe |
|---|---|
| **Beans** | Round, soft, and reliable. Just like a good base token. |
| **Fremy** | The default. A little mysterious, deeply trustworthy. |
| **BMO** | Chaotic good. Brings unexpected joy to every design review. |
| **Mr. Tibbs** | Distinguished. Has opinions about spacing. Always right. |

---

## License

MIT © Carina Berenices Velásquez
