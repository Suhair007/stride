import React, { useEffect, useMemo, useRef, useState } from "react";
import { Lock, Zap } from "lucide-react";

const CARD_H = 64;
const GAP = 10;
const HEAD = 44;
const CARD_PAD = 12;
const BOARD_H = HEAD + 3 * CARD_H + 2 * GAP + 16;
const cardTop = (slot) => HEAD + slot * (CARD_H + GAP);
const colLeft = (index) => `${((index * 100) / 3).toFixed(4)}%`;

const COL_KEYS = ["todo", "doing", "done"];
const COLUMNS = {
  todo: { name: "To do", color: "#b3a5e8" },
  doing: { name: "In progress", color: "#e0a14d" },
  done: { name: "Done", color: "#70ae8f" },
};
const PEOPLE = {
  alex: { name: "Alex", color: "#8272d5", initials: "AM" },
  sam: { name: "Sam", color: "#d98a70", initials: "SR" },
  mia: { name: "Mia", color: "#55a28a", initials: "MK" },
};
const SEED = {
  1: { id: 1, title: "Write launch announcement", tag: "Marketing", priority: "medium", who: "mia" },
  2: { id: 2, title: "Review pricing page", tag: "Growth", priority: "high", who: "sam" },
  3: { id: 3, title: "Fix mobile nav bug", tag: "Dev", priority: "urgent", who: "alex" },
  4: { id: 4, title: "Design onboarding flow", tag: "Design", priority: "high", who: "mia" },
  5: { id: 5, title: "Set up team workspace", tag: "Setup", priority: "low", who: "alex" },
};
const INITIAL_COLS = { todo: [1, 2, 3], doing: [4], done: [5] };
const POOL = [
  { title: "Plan the Q1 roadmap", tag: "Planning", priority: "medium", who: "sam" },
  { title: "Ship dark mode", tag: "Dev", priority: "high", who: "alex" },
  { title: "Update the help docs", tag: "Docs", priority: "low", who: "mia" },
  { title: "Prep the customer demo", tag: "Sales", priority: "high", who: "sam" },
  { title: "Invite the Pune branch", tag: "Team", priority: "medium", who: "alex" },
  { title: "Audit onboarding emails", tag: "Growth", priority: "medium", who: "mia" },
];
const FIRST_ACTIVITY = { key: 0, who: "mia", verb: "commented on", title: "Design onboarding flow", prep: null, target: null };
const IDLE_CURSOR = { left: "calc(100% - 24px)", top: HEAD + 150, who: "sam", grabbing: false, visible: false };
const QUOTES = [
  { text: "Big things happen when everyone can see the little things.", sub: "One team. One flow. All together." },
  { text: "Every branch gets its own board, and every board stays in sync.", sub: "Private by design, live by default." },
  { text: "Move a card and your whole team sees it, instantly.", sub: "Real-time, without the refresh." },
  { text: "Ask the board what needs attention, then approve the plan.", sub: "A guide that never changes anything without you." },
];
const QUOTE_MS = 6500;

export default function AuthVisual({ appName = "Stride", appMark = "s" }) {
  const reduced = useMemo(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    [],
  );
  const rootRef = useRef(null);
  const tiltRef = useRef(null);
  const [cards, setCards] = useState(SEED);
  const [cols, setCols] = useState(INITIAL_COLS);
  const [cursor, setCursor] = useState(IDLE_CURSOR);
  const [dragId, setDragId] = useState(null);
  const [dropCol, setDropCol] = useState(null);
  const [leavingId, setLeavingId] = useState(null);
  const [celebrateId, setCelebrateId] = useState(null);
  const [newId, setNewId] = useState(null);
  const [typing, setTyping] = useState(null);
  const [activity, setActivity] = useState(FIRST_ACTIVITY);
  const [shipped, setShipped] = useState(24);
  const [quote, setQuote] = useState(0);

  useEffect(() => {
    if (reduced) return undefined;
    const timers = new Set();
    const later = (fn, ms) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, ms);
      timers.add(timer);
    };
    const wait = (ms) => new Promise((resolve) => later(resolve, ms));
    const live = { cols: INITIAL_COLS, cards: { ...SEED }, next: 6, pool: 0, shipped: 24, act: 0 };

    const commit = (next) => {
      live.cols = next;
      setCols(next);
    };
    const locate = (id) => {
      for (let columnIndex = 0; columnIndex < COL_KEYS.length; columnIndex += 1) {
        const slot = live.cols[COL_KEYS[columnIndex]].indexOf(id);
        if (slot >= 0) return { columnIndex, slot };
      }
      return null;
    };
    const point = (columnIndex, slot, who, grabbing = false) => ({
      left: `calc(${colLeft(columnIndex)} + ${CARD_PAD + 34}px)`,
      top: cardTop(slot) + 22,
      who,
      grabbing,
      visible: true,
    });
    const announce = (who, verb, title, prep, target) => {
      live.act += 1;
      setActivity({ key: live.act, who, verb, title, prep, target });
    };

    const moveCard = async (who, id, toKey) => {
      const location = locate(id);
      if (!location) return;
      const fromKey = COL_KEYS[location.columnIndex];
      setCursor(point(location.columnIndex, location.slot, who));
      await wait(1000);
      setCursor((current) => ({ ...current, grabbing: true }));
      setDragId(id);
      setDropCol(toKey);
      await wait(280);
      const destination = [...live.cols[toKey], id];
      commit({
        ...live.cols,
        [fromKey]: live.cols[fromKey].filter((cardId) => cardId !== id),
        [toKey]: destination,
      });
      setCursor(point(COL_KEYS.indexOf(toKey), destination.length - 1, who, true));
      await wait(900);
      setCursor((current) => ({ ...current, grabbing: false }));
      setDragId(null);
      setDropCol(null);
      await wait(300);
    };

    const run = async () => {
      await wait(1400);
      for (let phase = 0; ; phase += 1) {
        const step = phase % 3;
        if (step === 0) {
          const id = live.cols.todo[0];
          await moveCard("sam", id, "doing");
          announce("sam", "moved", live.cards[id].title, "to", COLUMNS.doing.name);
        } else if (step === 1) {
          const id = live.cols.doing[0];
          await moveCard("mia", id, "done");
          setCelebrateId(id);
          later(() => setCelebrateId(null), 1300);
          live.shipped += 1;
          setShipped(live.shipped);
          announce("mia", "completed", live.cards[id].title, null, null);
        } else {
          if (live.cols.done.length > 2) {
            const old = live.cols.done[0];
            setLeavingId(old);
            await wait(450);
            commit({ ...live.cols, done: live.cols.done.filter((id) => id !== old) });
            setLeavingId(null);
            delete live.cards[old];
            setCards({ ...live.cards });
            await wait(600);
          }
          const spec = POOL[live.pool % POOL.length];
          live.pool += 1;
          const id = live.next;
          live.next += 1;
          live.cards[id] = { id, ...spec };
          setCards({ ...live.cards });
          setCursor(point(0, live.cols.todo.length, "alex"));
          await wait(1000);
          setCursor((current) => ({ ...current, grabbing: true }));
          await wait(180);
          commit({ ...live.cols, todo: [...live.cols.todo, id] });
          setNewId(id);
          setTyping({ id, text: "" });
          setCursor((current) => ({ ...current, grabbing: false }));
          for (let index = 1; index <= spec.title.length; index += 1) {
            setTyping({ id, text: spec.title.slice(0, index) });
            await wait(42);
          }
          await wait(300);
          setTyping(null);
          setNewId(null);
          announce("alex", "created", spec.title, "in", COLUMNS.todo.name);
          await wait(700);
          setCursor((current) => ({ ...current, visible: false }));
        }
        await wait(1600);
      }
    };

    void run();
    return () => timers.forEach(clearTimeout);
  }, [reduced]);

  useEffect(() => {
    if (reduced) return undefined;
    const timer = setInterval(() => setQuote((current) => (current + 1) % QUOTES.length), QUOTE_MS);
    return () => clearInterval(timer);
  }, [reduced]);

  const onMove = (event) => {
    if (reduced || !rootRef.current || !tiltRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    tiltRef.current.style.setProperty("--px", ((event.clientX - rect.left) / rect.width - 0.5).toFixed(3));
    tiltRef.current.style.setProperty("--py", ((event.clientY - rect.top) / rect.height - 0.5).toFixed(3));
  };
  const onLeave = () => {
    tiltRef.current?.style.setProperty("--px", "0");
    tiltRef.current?.style.setProperty("--py", "0");
  };

  const where = {};
  COL_KEYS.forEach((key, columnIndex) => {
    cols[key].forEach((id, slot) => { where[id] = { columnIndex, slot }; });
  });
  const ids = Object.keys(where).map(Number).sort((a, b) => a - b);
  const mover = cursor.visible ? cursor.who : null;
  const who = PEOPLE[activity.who];
  const slug = appName.toLowerCase();

  return (
    <div className="auth-visual" ref={rootRef} onMouseMove={onMove} onMouseLeave={onLeave}>
      <div className="av-aurora" aria-hidden="true"><i /><i /><i /></div>
      <div className="av-grid" aria-hidden="true" />
      <div className="av-orbit av-orbit-a" aria-hidden="true" />
      <div className="av-orbit av-orbit-b" aria-hidden="true" />
      <span className="av-spark av-spark-a" aria-hidden="true">✳</span>
      <span className="av-spark av-spark-b" aria-hidden="true">✳</span>
      <span className="av-spark av-spark-c" aria-hidden="true">✳</span>

      <div className="auth-brand">
        <div className="brand-mark">{appMark}</div>
        <span className="brand-name">{slug}<span className="brand-period">.</span></span>
      </div>

      <div className="av-stage" aria-hidden="true">
        <div className="av-tilt" ref={tiltRef}>
          <div className="av-window">
            <div className="av-chrome">
              <span className="av-dots"><i /><i /><i /></span>
              <span className="av-url"><Lock size={9} /> {slug}.app / launch-board</span>
            </div>
            <div className="av-appbar">
              <div><strong>Product launch</strong><small>Mumbai branch · 3 teammates</small></div>
              <div className="av-presence">
                {Object.entries(PEOPLE).map(([key, person]) => (
                  <span key={key} className={`av-ava ${mover === key ? "is-active" : ""}`} style={{ background: person.color, "--c": person.color }}>{person.initials}</span>
                ))}
                <span className="av-online">3 online</span>
              </div>
            </div>

            <div className="av-board" style={{ height: BOARD_H }}>
              {COL_KEYS.map((key, index) => (
                <div key={key} className={`av-col ${dropCol === key ? "is-target" : ""}`} style={{ left: colLeft(index) }}>
                  <div className="av-col-head" style={{ "--c": COLUMNS[key].color }}>
                    <i />{COLUMNS[key].name}<b>{cols[key].length}</b>
                  </div>
                </div>
              ))}

              {ids.map((id) => {
                const { columnIndex, slot } = where[id];
                const key = COL_KEYS[columnIndex];
                const card = cards[id];
                if (!card) return null;
                const person = PEOPLE[card.who];
                const text = typing?.id === id ? typing.text : card.title;
                const className = [
                  "av-card",
                  key === "done" && "is-done",
                  dragId === id && "is-dragging",
                  leavingId === id && "is-leaving",
                  celebrateId === id && "is-celebrating",
                  newId === id && "is-new",
                ].filter(Boolean).join(" ");
                return (
                  <article key={id} className={className} style={{ left: `calc(${colLeft(columnIndex)} + ${CARD_PAD}px)`, top: cardTop(slot), width: `calc(33.3333% - ${CARD_PAD * 2}px)` }}>
                    <div className="av-card-top">
                      <span className={`av-pri av-pri-${card.priority}`} />
                      <span className="av-card-title">{text}{typing?.id === id && <span className="av-caret" />}</span>
                    </div>
                    <div className="av-card-bottom">
                      <span className="av-tag">{card.tag}</span>
                      <span className="av-ava av-ava-tiny" style={{ background: person.color }}>{person.initials}</span>
                    </div>
                  </article>
                );
              })}

              <div className={`av-cursor ${cursor.visible ? "is-visible" : ""} ${cursor.grabbing ? "is-grabbing" : ""}`} style={{ left: cursor.left, top: cursor.top, "--c": PEOPLE[cursor.who].color }}>
                <svg width="18" height="22" viewBox="0 0 18 22"><path d="M2 1.5v16l4.4-4.1 3.2 7 2.8-1.3-3.2-6.9 6-.4L2 1.5z" fill={PEOPLE[cursor.who].color} stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" /></svg>
                <span className="av-cursor-label">{PEOPLE[cursor.who].name}</span>
              </div>
            </div>
          </div>

          <div className="av-float av-float-stat">
            <div className="av-float-card">
              <span className="av-stat-icon"><Zap size={15} /></span>
              <span className="av-stat-copy"><small>Tasks shipped</small><strong key={shipped} className="av-count">{shipped}</strong></span>
            </div>
          </div>

          <div className="av-float av-float-toast">
            <div className="av-float-card">
              <span className="av-ava av-ava-small" style={{ background: who.color }}>{who.initials}</span>
              <p key={activity.key} className="av-toast">
                <strong>{who.name}</strong> {activity.verb} <em>{activity.title}</em>
                {activity.target && <> {activity.prep} <b>{activity.target}</b></>}
                <small>just now</small>
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="auth-quote av-quote">
        <span className="quote-mark">“</span>
        <div key={quote} className="av-quote-inner">
          <p>{QUOTES[quote].text}</p>
          <span>{QUOTES[quote].sub}</span>
        </div>
      </div>

      <div className="auth-visual-footer">
        <span>Thoughtful work, in good company.</span>
        <span className="av-pager">
          <span className="av-segs" aria-hidden="true">
            {QUOTES.map((_, index) => (
              <span key={index} className="av-seg">
                <i className={index < quote || (reduced && index === quote) ? "is-full" : index === quote ? "is-active" : ""} style={index === quote ? { animationDuration: `${QUOTE_MS}ms` } : undefined} />
              </span>
            ))}
          </span>
          {String(quote + 1).padStart(2, "0")} — {String(QUOTES.length).padStart(2, "0")}
        </span>
      </div>
    </div>
  );
}
