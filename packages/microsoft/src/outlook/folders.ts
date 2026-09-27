import { GraphApiError, type GraphApi } from "../api.js";

/** Outlook's own folders, by the names Graph knows them by in every mailbox language. */
export const WELL_KNOWN_FOLDERS: ReadonlySet<string> = new Set([
  "inbox",
  "archive",
  "deleteditems",
  "drafts",
  "junkemail",
  "sentitems",
  "outbox",
  "scheduled",
  "conversationhistory",
  "msgfolderroot",
]);

interface MailFolder {
  id: string;
  displayName?: string;
}

/**
 * The folder at a path such as "Receipts" or "Inbox/Receipts": each part is a folder's name,
 * matched without case, and the first can be a well-known name such as "archive". Returns the
 * folder's id, or the well-known name itself. With `create`, missing folders are made.
 */
export async function findFolder(api: GraphApi, path: string, options: { create?: boolean } = {}): Promise<string> {
  const parts = path
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error('Name an Outlook folder, such as "Receipts" or "Inbox/Receipts".');
  let parent: string | undefined;
  for (const [index, part] of parts.entries()) {
    if (index === 0 && WELL_KNOWN_FOLDERS.has(part.toLowerCase())) {
      parent = part.toLowerCase();
      continue;
    }
    parent = await childFolder(api, parent, part, options.create ?? false, parts.slice(0, index + 1).join("/"));
  }
  return parent as string;
}

async function childFolder(api: GraphApi, parent: string | undefined, name: string, create: boolean, path: string): Promise<string> {
  const base = parent === undefined ? "/me/mailFolders" : `/me/mailFolders/${encodeURIComponent(parent)}/childFolders`;
  const find = async () => {
    const folders = await api.all<MailFolder>(base, {
      query: { $filter: `displayName eq '${name.replace(/'/g, "''")}'`, $select: "id,displayName", $top: 10 },
    });
    return (folders.find((folder) => folder.displayName?.toLowerCase() === name.toLowerCase()) ?? folders[0])?.id;
  };
  const existing = await find();
  if (existing) return existing;
  if (!create) {
    const hint = parent === undefined ? ` If it's inside your inbox, use "Inbox/${path}".` : "";
    throw new Error(`There's no Outlook folder "${path}".${hint}`);
  }
  try {
    return (await api.call<MailFolder>("POST", base, { body: { displayName: name } })).id;
  } catch (error) {
    // Someone else created it a moment ago.
    if (error instanceof GraphApiError && (error.status === 409 || error.code === "ErrorFolderExists")) {
      const again = await find();
      if (again) return again;
    }
    throw error;
  }
}
