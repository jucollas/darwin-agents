"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const EXAMPLES = [
  {
    name: "Aurora Sleep Mask",
    priceUsd: 49,
    margin: 0.62,
    category: "wellness",
  },
  {
    name: "Cafetera Chemex 6 tazas",
    priceUsd: 82,
    margin: 0.45,
    category: "home",
  },
  {
    name: "Curso de fotografía nocturna",
    priceUsd: 180,
    margin: 0.85,
    category: "education",
  },
];

export function SetupForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [product, setProduct] = useState(EXAMPLES[0]);
  // The photo rides along as a data: URL so it can be posted as JSON and shown as a preview.
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);

  /**
   * The four numbers that decide what the contract will allow, kept in state so the form
   * can say what they mean together before anyone commits money to them.
   *
   * The per-agent and per-day ceilings used to be derived behind the form — budget × 3.5%,
   * then a twelfth of that — and never shown. They are the two limits an agent actually
   * dies against, so they are asked for.
   */
  const [budget, setBudget] = useState(150);
  const [population, setPopulation] = useState(6);
  const [perAgent, setPerAgent] = useState(25);
  const [epochCap, setEpochCap] = useState(6);
  const overAllocated = population * perAgent > budget;

  /** Read the file into a data: URL. 4 MB keeps the request well under the API's limit. */
  function onPhoto(event: React.ChangeEvent<HTMLInputElement>) {
    setPhotoError(null);
    const file = event.target.files?.[0];
    if (!file) return setPhoto(null);
    if (file.size > 4_000_000) {
      setPhotoError("That photo is over 4 MB. Use a smaller one.");
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPhoto(String(reader.result));
    reader.onerror = () => setPhotoError("Could not read that file.");
    reader.readAsDataURL(file);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const populationSize = Number(form.get("populationSize"));
    const budgetUsd = Number(form.get("budgetUsd"));

    const res = await fetch("/api/campaign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        product: {
          name: form.get("name"),
          priceUsd: Number(form.get("priceUsd")),
          margin: Number(form.get("margin")) / 100,
          category: form.get("category"),
        },
        budgetUsd,
        populationSize,
        perAgentUsd: Number(form.get("perAgentUsd")),
        epochCapUsd: Number(form.get("epochCapUsd")),
        seed: form.get("seed") ? Number(form.get("seed")) : undefined,
        context: form.get("context") ?? "",
        audience: form.get("audience") ?? "",
        images: photo ? [photo] : [],
      }),
    });

    if (!res.ok) {
      setError(
        (await res.json().catch(() => ({})))?.error ??
          "Could not start the campaign.",
      );
      setSubmitting(false);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "0 1rem 5rem" }}>
      <header style={{ paddingTop: "4rem", paddingBottom: "2rem" }}>
        <h1
          style={{ fontSize: "clamp(2.2rem, 6vw, 3.4rem)", maxWidth: "16ch" }}
        >
          Stop guessing which ad works
        </h1>
        <p
          style={{
            color: "var(--ink-soft)",
            marginTop: "1rem",
            maxWidth: "58ch",
          }}
        >
          Tell us what you are selling and how much you are willing to lose
          finding out. We put a population of agents on it — each one betting on
          a different strategy, each with its own wallet and a budget it cannot
          exceed. The ones that lose money are shut down. The ones that make
          money breed.
        </p>
        <p
          style={{
            color: "var(--ink-faint)",
            marginTop: "0.75rem",
            maxWidth: "58ch",
            fontSize: 14,
          }}
        >
          There are 40,500 strategies in the search space. Nobody has the budget
          to try them one at a time.
        </p>
      </header>

      <form
        onSubmit={onSubmit}
        className="band"
        style={{ paddingTop: "1.75rem" }}
      >
        <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
          <legend
            style={{
              padding: 0,
              marginBottom: "1rem",
              fontSize: "1.15rem",
              fontFamily: "var(--font-display)",
            }}
          >
            What are you selling?
          </legend>

          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              flexWrap: "wrap",
              marginBottom: "1.25rem",
            }}
          >
            {EXAMPLES.map((example) => (
              <button
                key={example.name}
                type="button"
                className="press"
                style={{
                  fontSize: 13,
                  padding: "0.3rem 0.6rem",
                  borderColor:
                    product.name === example.name
                      ? "var(--ink)"
                      : "var(--rule-strong)",
                }}
                onClick={() => setProduct(example)}
              >
                {example.name}
              </button>
            ))}
          </div>

          <Field label="Product name" hint="Whatever your buyers call it.">
            <input
              name="name"
              required
              defaultValue={product.name}
              key={`n-${product.name}`}
            />
          </Field>

          <Row>
            <Field label="Price" hint="What a buyer pays.">
              <input
                name="priceUsd"
                type="number"
                min={1}
                step="0.01"
                required
                className="tnum"
                defaultValue={product.priceUsd}
                key={`p-${product.name}`}
              />
            </Field>
            <Field
              label="Margin %"
              hint="What is left after the cost of goods."
            >
              <input
                name="margin"
                type="number"
                min={1}
                max={100}
                required
                className="tnum"
                defaultValue={Math.round(product.margin * 100)}
                key={`m-${product.name}`}
              />
            </Field>
            <Field label="Category" hint="Shapes who is likely to buy.">
              <input
                name="category"
                required
                defaultValue={product.category}
                key={`c-${product.name}`}
              />
            </Field>
          </Row>

          <Field
            label="What are you selling?"
            hint="A sentence or two in your own words. The agents read this before they pitch."
          >
            <textarea
              name="context"
              rows={3}
              placeholder="Single-origin beans from Nariño, roasted last week. Tastes like panela and orange."
              style={{ width: "100%", font: "inherit", padding: "0.5rem" }}
            />
          </Field>

          <Field
            label="Who should buy it?"
            hint="Optional. The agents weigh this when they choose who to talk to."
          >
            <input
              name="audience"
              placeholder="Coffee drinkers who grind their own beans"
            />
          </Field>

          <Field
            label="Photo of the product"
            hint="Optional. The agents look at it and use what they see."
          >
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={onPhoto}
            />
          </Field>
          {photoError && (
            <p style={{ color: "var(--loss, #b4462f)" }}>{photoError}</p>
          )}
          {photo && (
            <div style={{ marginTop: "0.5rem" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photo}
                alt="The product the agents will pitch"
                style={{
                  maxHeight: 160,
                  borderRadius: 4,
                  border: "1px solid var(--rule, #d9d2c5)",
                }}
              />
              <button
                type="button"
                onClick={() => setPhoto(null)}
                style={{ display: "block", marginTop: "0.4rem", fontSize: "0.8rem" }}
              >
                Remove photo
              </button>
            </div>
          )}
        </fieldset>

        <fieldset
          className="band"
          style={{
            border: "none",
            padding: "1.75rem 0 0",
            margin: "1.75rem 0 0",
          }}
        >
          <legend
            style={{
              padding: 0,
              marginBottom: "1rem",
              fontSize: "1.15rem",
              fontFamily: "var(--font-display)",
            }}
          >
            How much can they spend?
          </legend>

          <Row>
            <Field
              label="How much are you putting in?"
              hint="The whole campaign. No agent can spend past this — the contract reverts, it is not a setting we check."
            >
              <input
                name="budgetUsd"
                type="number"
                min={10}
                step={10}
                required
                className="tnum"
                defaultValue={budget}
                onChange={(e) => setBudget(Number(e.currentTarget.value))}
              />
            </Field>
            <Field
              label="How many agents should try?"
              hint="Each gets its own wallet and an equal cut to start. More agents search wider, but each one gets less to prove itself with."
            >
              <input
                name="populationSize"
                type="number"
                min={2}
                max={12}
                required
                className="tnum"
                defaultValue={population}
                onChange={(e) => setPopulation(Number(e.currentTarget.value))}
              />
            </Field>
          </Row>

          <Row>
            <Field
              label="What can one agent spend in its whole life?"
              hint="Its ceiling from birth to shutdown. Spending it all is how an agent dies."
            >
              <input
                name="perAgentUsd"
                type="number"
                min={1}
                step={1}
                required
                className="tnum"
                value={perAgent}
                onChange={(e) => setPerAgent(Number(e.currentTarget.value))}
              />
            </Field>
            <Field
              label="And how much in a single day?"
              hint="Stops one agent burning its whole budget on a bad idea before the numbers come back."
            >
              <input
                name="epochCapUsd"
                type="number"
                min={1}
                step={1}
                required
                className="tnum"
                value={epochCap}
                onChange={(e) => setEpochCap(Number(e.currentTarget.value))}
              />
            </Field>
            <Field label="Seed" hint="Leave empty for a fresh market.">
              <input
                name="seed"
                type="number"
                className="tnum"
                placeholder="random"
              />
            </Field>
          </Row>

          {/* What those four numbers actually mean, in a sentence, before committing. */}
          <p
            style={{
              color: overAllocated ? "var(--dead)" : "var(--ink-soft)",
              fontSize: 14,
              marginTop: "1rem",
              maxWidth: "64ch",
            }}
          >
            {overAllocated ? (
              <>
                {population} agents at ${perAgent.toFixed(0)} each comes to $
                {(population * perAgent).toFixed(0)}, which is more than the $
                {budget.toFixed(0)} you are putting in. Lower the per-agent
                ceiling or raise the budget.
              </>
            ) : (
              <>
                {population} agents start with ${perAgent.toFixed(0)} each to
                spend over their lifetime, at most ${epochCap.toFixed(0)} a day
                — so this generation can spend $
                {(population * epochCap).toFixed(0)} a day between them, and an
                agent takes about{" "}
                {Math.max(1, Math.round(perAgent / epochCap))} days to exhaust
                itself. The other $
                {(budget - population * perAgent).toFixed(0)} is held back to
                fund the children of whichever strategies work.
              </>
            )}
          </p>
        </fieldset>

        {error && (
          <p
            role="alert"
            style={{ color: "var(--dead)", marginTop: "1.25rem" }}
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          className="press press-solid"
          disabled={submitting || overAllocated}
          style={{ marginTop: "1.75rem" }}
        >
          {submitting
            ? "The agents are writing their ads…"
            : "Launch autonomous agents"}
        </button>
      </form>
    </main>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: "1rem",
      }}
    >
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", marginBottom: "1rem" }}>
      <span style={{ display: "block", marginBottom: "0.3rem" }}>{label}</span>
      {children}
      <span
        style={{
          display: "block",
          color: "var(--ink-faint)",
          fontSize: 13,
          marginTop: "0.3rem",
        }}
      >
        {hint}
      </span>
    </label>
  );
}
