"use client";
// The assistant as a full-screen app, laid out like ChatGPT: chat history in a sidebar, the conversation
// on the right. It lives in the layout, so switching chats (/ ↔ /c/<id>) never remounts it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import Chat, { type ChatEvents } from "./Chat";
import { BagIcon, DotsIcon, GiftIcon, GridIcon, MenuIcon, NewChatIcon, PencilIcon, SearchIcon, SidebarIcon, XIcon } from "./ui";

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: string;
}

function chatIdFrom(path: string | null): string | null {
  const m = path?.match(/^\/c\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Today / Yesterday / Previous 7 days / Previous 30 days / Month Year, like ChatGPT. */
function groupByDate(chats: ChatSummary[]): Array<[string, ChatSummary[]]> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86400_000;
  const groups = new Map<string, ChatSummary[]>();
  for (const c of chats) {
    const t = new Date(c.updatedAt).getTime();
    const label =
      t >= startOfToday
        ? "Today"
        : t >= startOfToday - day
          ? "Yesterday"
          : t >= startOfToday - 7 * day
            ? "Previous 7 days"
            : t >= startOfToday - 30 * day
              ? "Previous 30 days"
              : new Date(t).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    groups.set(label, [...(groups.get(label) ?? []), c]);
  }
  return [...groups];
}

export default function ChatApp(props: { storeName: string; initials: string; configured: boolean; cartCount: number; chats: ChatSummary[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const chatId = chatIdFrom(pathname);
  const [chats, setChats] = useState<ChatSummary[]>(props.chats);
  const [cartCount, setCartCount] = useState(props.cartCount);
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => setCartCount(props.cartCount), [props.cartCount]);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("cx-sidebar") === "closed");
    } catch {
      /* storage blocked */
    }
    // Refresh the list (another tab may have added chats).
    fetch("/api/assistant/chats")
      .then((r) => r.json())
      .then((d) => Array.isArray(d.chats) && setChats(d.chats))
      .catch(() => null);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem("cx-sidebar", c ? "open" : "closed");
      } catch {
        /* storage blocked */
      }
      return !c;
    });
  }, []);

  const newChat = useCallback(() => {
    setDrawer(false);
    router.push("/");
  }, [router]);

  // Ctrl/Cmd+Shift+O: new chat. Ctrl/Cmd+Shift+S: toggle the sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === "o") {
        e.preventDefault();
        newChat();
      } else if (k === "s") {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat, toggleCollapsed]);

  // Close the item menu on outside click.
  useEffect(() => {
    if (!menuFor) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuFor(null);
        setConfirmDelete(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuFor]);

  const events: ChatEvents = useMemo(
    () => ({
      onCreated: (id, title) => {
        setChats((c) => [{ id, title, updatedAt: new Date().toISOString() }, ...c.filter((x) => x.id !== id)]);
        // Same page, new address: the layout (and this chat) stay mounted.
        window.history.replaceState(null, "", `/c/${encodeURIComponent(id)}`);
      },
      onTitle: (id, title) => setChats((c) => c.map((x) => (x.id === id ? { ...x, title } : x))),
      onTouched: (id) =>
        setChats((c) => {
          const it = c.find((x) => x.id === id);
          return it ? [{ ...it, updatedAt: new Date().toISOString() }, ...c.filter((x) => x.id !== id)] : c;
        }),
      onMissing: () => router.replace("/"),
      onCart: setCartCount,
    }),
    [router],
  );

  async function rename(id: string, title: string) {
    const t = title.trim();
    setRenaming(null);
    if (!t) return;
    setChats((c) => c.map((x) => (x.id === id ? { ...x, title: t } : x)));
    await fetch(`/api/assistant/chats/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: t }) }).catch(() => null);
  }

  async function remove(id: string) {
    setMenuFor(null);
    setConfirmDelete(null);
    setChats((c) => c.filter((x) => x.id !== id));
    if (id === chatId) router.push("/");
    await fetch(`/api/assistant/chats/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
  }

  const shown = query.trim() ? chats.filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase())) : chats;
  const active = chats.find((c) => c.id === chatId);

  return (
    <div className={`app${collapsed ? " sb-collapsed" : ""}${drawer ? " sb-drawer" : ""}`}>
      <aside className="sb" aria-label="Chat history">
        <div className="sb-top">
          <Link href="/" className="sb-brand" onClick={() => setDrawer(false)} aria-label={`${props.storeName} home`}>
            <span className="brand-mark">{props.initials}</span>
            <span className="sb-brand-name">{props.storeName}</span>
          </Link>
          <button type="button" className="sb-icon hide-mobile" onClick={toggleCollapsed} aria-label="Close sidebar" title="Close sidebar (Ctrl+Shift+S)">
            <SidebarIcon />
          </button>
          <button type="button" className="sb-icon show-mobile" onClick={() => setDrawer(false)} aria-label="Close menu">
            <XIcon size={20} />
          </button>
        </div>

        <button type="button" className="sb-row sb-new" onClick={newChat} title="New chat (Ctrl+Shift+O)">
          <NewChatIcon />
          <span>New chat</span>
        </button>
        <label className="sb-search">
          <SearchIcon />
          <span className="sr-only">Search chats</span>
          <input type="search" placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <nav className="sb-links" aria-label="Store">
          <Link href="/search" className="sb-row">
            <GridIcon />
            <span>Browse catalog</span>
          </Link>
          <Link href="/boxes" className="sb-row">
            <GiftIcon />
            <span>Mystery boxes</span>
          </Link>
          <Link href="/account" className="sb-row">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <circle cx="12" cy="8" r="3.5" />
              <path d="M5 20a7 7 0 0 1 14 0" />
            </svg>
            <span>Account</span>
          </Link>
        </nav>

        <div className="sb-list">
          {shown.length === 0 && <p className="sb-empty">{query ? "No chats match." : "Your chats will show up here."}</p>}
          {groupByDate(shown).map(([label, items]) => (
            <div key={label} className="sb-group">
              <div className="sb-group-label">{label}</div>
              {items.map((c) =>
                renaming?.id === c.id ? (
                  <form
                    key={c.id}
                    className="sb-rename"
                    onSubmit={(e) => {
                      e.preventDefault();
                      rename(c.id, renaming.title);
                    }}
                  >
                    <input
                      autoFocus
                      value={renaming.title}
                      maxLength={80}
                      onChange={(e) => setRenaming({ id: c.id, title: e.target.value })}
                      onBlur={() => rename(c.id, renaming.title)}
                      onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
                      aria-label="Chat name"
                    />
                  </form>
                ) : (
                  <div key={c.id} className={`sb-item${c.id === chatId ? " is-active" : ""}${menuFor === c.id ? " is-menu" : ""}`}>
                    <Link href={`/c/${encodeURIComponent(c.id)}`} className="sb-item-link" onClick={() => setDrawer(false)} title={c.title}>
                      {c.title}
                    </Link>
                    <button
                      type="button"
                      className="sb-item-more"
                      aria-label={`Options for ${c.title}`}
                      onClick={() => {
                        setMenuFor(menuFor === c.id ? null : c.id);
                        setConfirmDelete(null);
                      }}
                    >
                      <DotsIcon />
                    </button>
                    {menuFor === c.id && (
                      <div className="sb-menu" ref={menuRef} role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenuFor(null);
                            setRenaming({ id: c.id, title: c.title });
                          }}
                        >
                          <PencilIcon /> Rename
                        </button>
                        {confirmDelete === c.id ? (
                          <button type="button" role="menuitem" className="sb-danger is-confirm" onClick={() => remove(c.id)}>
                            Delete for good?
                          </button>
                        ) : (
                          <button type="button" role="menuitem" className="sb-danger" onClick={() => setConfirmDelete(c.id)}>
                            <XIcon size={15} /> Delete
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ),
              )}
            </div>
          ))}
        </div>

        <div className="sb-foot">
          <Link href="/cart" className="sb-row sb-cart">
            <BagIcon />
            <span>Cart</span>
            {cartCount > 0 && <span className="sb-badge">{cartCount}</span>}
          </Link>
        </div>
      </aside>
      <div className="sb-scrim" onClick={() => setDrawer(false)} aria-hidden />

      <main className="main">
        <header className="topbar">
          <button type="button" className="sb-icon show-mobile" onClick={() => setDrawer(true)} aria-label="Open menu">
            <MenuIcon />
          </button>
          {collapsed && (
            <>
              <button type="button" className="sb-icon hide-mobile" onClick={toggleCollapsed} aria-label="Open sidebar" title="Open sidebar (Ctrl+Shift+S)">
                <SidebarIcon />
              </button>
              <button type="button" className="sb-icon hide-mobile" onClick={newChat} aria-label="New chat" title="New chat (Ctrl+Shift+O)">
                <NewChatIcon />
              </button>
            </>
          )}
          <div className="topbar-title">{active ? active.title : <span className="topbar-brand">{props.storeName} <span>Shopping assistant</span></span>}</div>
          <button type="button" className="sb-icon show-mobile" onClick={newChat} aria-label="New chat">
            <NewChatIcon />
          </button>
          <Link href="/cart" className="topbar-cart hide-mobile" aria-label={`Cart, ${cartCount} items`}>
            <BagIcon />
            <span>Cart</span>
            {cartCount > 0 && <span className="sb-badge">{cartCount}</span>}
          </Link>
        </header>
        <Chat chatId={chatId} configured={props.configured} cartCount={cartCount} events={events} />
      </main>
    </div>
  );
}
