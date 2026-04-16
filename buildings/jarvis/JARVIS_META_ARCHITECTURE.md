# Jarvis — Meta-Architecture

A reference document. This is the framework Jarvis is being built around. It describes the surfaces, the layers, and — most importantly — the rules of *how* the system grows. It is intentionally written without concrete examples so that the framework remains the framework, not a memorized instance of it.

This is the reference, not the build. The current Jarvis implementation only partially realizes what is described here. The point of this document is to keep the long-term shape of the system stable while the build catches up.

---

## 0. Stance

Jarvis is a research environment for understanding *what makes a piece of content perform*, where "perform" is defined by a small number of outcome metrics that are non-negotiable, and everything underneath those metrics is treated as an open search space.

The system has two jobs:

1. **Observe**, at as many resolutions as possible, the things that can be seen about a piece of content and its post-upload life.
2. **Explain**, in terms of mechanisms and principles, *why* the observations relate to the outcome — in a form that can change creative behavior on the next piece of content.

These two jobs are kept separate on purpose. Observation is wide and shallow. Explanation is narrow and deep. The architecture below preserves that separation.

---

## 1. The layers

The system is organized as a small number of layers. Each layer has a clear role. The layers are stable; the contents of the layers are emergent.

```
┌────────────────────────────────────────────────────────┐
│  Outcome metric(s)         (the thing being optimized) │
├────────────────────────────────────────────────────────┤
│  Post-upload indicators    (signals that appear after  │
│                             upload and predict outcome)│
├────────────────────────────────────────────────────────┤
│  Pre-upload indicators     (everything observable and  │
│                             actionable before upload)  │
├────────────────────────────────────────────────────────┤
│  Mechanisms                (the *moves* a creator can  │
│                             make; what was done)       │
├────────────────────────────────────────────────────────┤
│  Components                (recurring sub-parts that   │
│                             emerge from many mechanisms)│
├────────────────────────────────────────────────────────┤
│  Principles                (the *why*: why this        │
│                             mechanism shifts that      │
│                             indicator in that direction)│
└────────────────────────────────────────────────────────┘
```

Resolution cuts across every layer. Any indicator, mechanism, component, or principle can be observed and stated at multiple resolutions — coarse to fine — and the same idea may appear at more than one resolution simultaneously.

The remainder of this document walks each layer in detail, then describes how they connect, how the system grows, and what the build vision looks like in stages.

---

## 2. Outcome metric

There is a single master outcome the system is trying to predict and improve. Everything else in the system is downstream of this. It is the only place in the architecture where a hardcoded definition is acceptable, because the entire framework is built to serve it.

Properties of the outcome metric:

- It is the ground truth. Indicators are only valuable to the degree that they predict it.
- It is stated in absolute terms, not relative. The system does not compare pieces of content against each other; it predicts the absolute outcome of each.
- It is allowed to be transformed (e.g., logarithmically) for modeling, but the underlying definition does not move.

If a second outcome metric is ever added, it is added at this layer and treated with the same weight. The system does not silently optimize for proxy metrics that drift from the master outcome.

---

## 3. Post-upload indicators

Post-upload indicators are signals that only become observable *after* a piece of content has been published. They sit between mechanisms and the outcome metric in the causal chain.

Their role in the architecture:

- They give the system a **denser, faster signal** than the outcome alone. The outcome metric matures slowly and has high variance; post-upload indicators move earlier and more reliably.
- They serve as **intermediate prediction targets**. Predicting them well is a stepping stone to predicting the outcome.
- They are **diagnostic**: when the outcome moves, post-upload indicators help localize *where* in the lifecycle the movement happened.

Important properties:

- Post-upload indicators are not ends in themselves. A model that predicts a post-upload indicator perfectly but cannot connect that prediction back to mechanisms a creator can use does not advance the system.
- They can be observed at many resolutions. A single post-upload indicator can be measured globally (over the whole piece of content and its whole post-upload life) or windowed in time, in position, in audience segment, or in any other slicing that becomes useful.
- They form a graph with each other and with the outcome metric. Some post-upload indicators predict others, and the structure of those predictions is itself a useful object of study.

The system collects post-upload indicators broadly. It does not pre-decide which ones matter most.

---

## 4. Pre-upload indicators

Pre-upload indicators are anything observable about the content (or its surrounding context) *before* it is uploaded. This is the layer where the most aggressive emergence is required, and where rigid pre-categorization does the most damage.

The working definition is intentionally broad and negative:

> A pre-upload indicator is anything that is **not** a post-upload indicator, that can be observed about the content or its context **before publication**, and that can in principle be tied to a creative choice.

That is the entire definition. The system does not commit upfront to a fixed taxonomy of pre-upload indicator types (visual, textual, structural, semantic, etc.). Those groupings may end up being useful, but they are *outputs* of the system, not inputs to it.

Properties of the pre-upload layer:

- It is the layer where mechanisms become testable in advance. A mechanism that cannot be tied to any pre-upload indicator cannot be evaluated before upload, only after — which limits its usefulness as guidance.
- It is allowed to be **wide and noisy**. Many pre-upload indicators will turn out to be uncorrelated with the outcome. That is fine. The system filters down later.
- It is the layer most prone to over-engineering. The system should resist the temptation to build elaborate ontologies of pre-upload features before there is evidence those ontologies carve reality at the joints.

The reason for the broad definition is the same reason for the broad collection policy in §10: the system only knows which slices of pre-upload reality matter after it has seen many mechanisms succeed and fail in those slices. Pre-categorizing closes off discovery.

---

## 5. Mechanisms

A mechanism is something a creator *did* — a move, a choice, an intervention — that can in principle be repeated, varied, or avoided on a future piece of content.

This is the most underdeveloped layer of the system today, and the one with the most upside.

Properties:

- Mechanisms are described in **rough natural language** initially. Perfect ontology is not required. The first useful description of a mechanism is whatever lets a human reader recognize the same mechanism the next time they see it.
- A mechanism can sit at many resolutions: a single tiny edit, a recurring stylistic choice, a structural pattern that spans the whole piece, or an even higher-level strategy that spans many pieces.
- Mechanisms are **observed**, not invented. The system records what was actually done, in whatever vocabulary fits, and lets recurring shapes surface over time.
- A mechanism is not the same as a pre-upload indicator. A pre-upload indicator describes *a property of the content as it exists*. A mechanism describes *the move that produced that property*. The same indicator can be produced by very different mechanisms, and the same mechanism can produce different indicators in different contexts. Keeping these distinct is important.
- Mechanisms are linked to the indicators they are believed to affect (both pre-upload and post-upload), and through those indicators to the outcome.

The system does not require a mechanism to be expressible in a clean schema before it can be recorded. A messy description that names the move correctly is more valuable than a clean schema that loses what the move actually was.

---

## 6. Components

Components are the recurring sub-parts of mechanisms that emerge after many mechanisms have been described.

Properties:

- Components are **bottom-up**. They are not declared in advance. The system notices that the same fragment shows up across many mechanisms and lifts that fragment into a named component.
- A component is useful when it lets two seemingly different mechanisms be recognized as instances of the same underlying move (with variation), or when it lets a mechanism be decomposed into smaller, more general moves.
- The component layer is where the vocabulary of the system gets sharper over time. Early mechanism descriptions are rough; as components emerge, mechanisms can be re-described in component terms, which compresses the catalog and makes the patterns easier to see.
- Components inherit the same multi-resolution property as everything else: a component can itself be made of smaller components.

The architectural rule is: **do not define components first.** Define mechanisms first, in whatever language fits, and let the components fall out of repeated observation. Premature components freeze the wrong abstraction in place.

---

## 7. Principles

Principles are the **why** layer. A principle answers the question:

> *Why does this mechanism move this indicator in this direction (and through what chain does it eventually move the outcome)?*

Properties:

- A principle is a **causal hypothesis**, not a description. A description tells you what was done; a principle tells you why doing it had the effect it had.
- Principles connect mechanisms to indicators, and indicators to the outcome. They are the glue that makes the system explanatory rather than merely correlational.
- Principles can be tested. A principle implies predictions: if the principle is right, then varying the mechanism in a specific way should move the indicator in a specific way. Those predictions are the input to future experiments.
- Principles, like everything else, sit at multiple resolutions. There are very local principles (about a specific mechanism and a specific indicator), and there are general principles that span many mechanisms and many indicators.
- Principles are also emergent. The system is not seeded with a fixed list of "the principles." It discovers them by repeatedly asking *why* a measured relationship exists, proposing candidate explanations, and testing them.

Principles are what make the system actually useful for a creator. Knowing that an indicator predicts the outcome is not enough — it tells you nothing about what to do differently. Knowing the principle behind that prediction tells you which mechanisms to use to influence the indicator and, through it, the outcome.

---

## 8. Resolution

Resolution is not a layer. It is an axis that runs through every layer.

Anything in the system — an indicator (pre or post), a mechanism, a component, a principle — can be expressed at multiple resolutions. The same idea can be observed coarsely (over the whole piece of content, the whole post-upload window, the whole audience) or finely (over a specific slice in time, position, audience segment, modality, etc.).

Why resolution is central:

- The same underlying phenomenon can look very different at different resolutions. A relationship that is invisible globally can be obvious in a narrow window, and vice versa.
- The system cannot know in advance which resolution is the right one for a given question. It must be able to *vary the resolution* and see what happens.
- Resolution is the main reason the architecture must be flexible about taxonomy. A pre-categorization that fixes the resolution at which a kind of indicator is measured will make many real patterns invisible.

Practically, this means every observable thing in the system carries information about the resolution at which it was observed, and the system can compare the same underlying thing across resolutions.

Resolution applies to mechanisms and principles too, not just indicators. A mechanism can be a single small move or a long structural pattern. A principle can be local or general. The system should be able to hold and compare both.

---

## 9. Emergence vs pre-categorization

This is the core methodological commitment of the architecture. It deserves its own section because it is the rule that prevents most of the failure modes.

The rule:

> **Categories should emerge from observation. The system pre-categorizes only where it has no choice.**

The places where pre-categorization is unavoidable, and therefore allowed:

- The outcome metric. There has to be a defined target.
- The split between pre-upload and post-upload. This is a real, observable boundary in time, not an opinion about content.
- The layer structure itself (outcome / indicator / mechanism / component / principle). This is the architectural skeleton.

Everywhere else, categories should be allowed to form. Specifically:

- The system does **not** start with a fixed list of pre-upload indicator categories. It collects pre-upload indicators broadly and notices groupings later.
- The system does **not** start with a fixed list of mechanism categories. Mechanisms are described in rough language, and categories emerge as the same shapes appear repeatedly.
- The system does **not** start with a fixed list of components. Components are lifted out of mechanisms after repeated observation.
- The system does **not** start with a fixed list of principles. Principles are proposed in response to observed relationships and refined over time.

Why this matters: a hardcoded taxonomy is a frozen guess about what the world is made of. If the guess is wrong — and at the start of the research, it almost certainly is — the taxonomy filters out exactly the discoveries that would have corrected it. Emergent categorization keeps the search space open long enough for the actual structure to reveal itself.

The cost of emergent categorization is messiness in the early data. That is the right cost to pay. Cleaning up emergent vocabulary later is easy; recovering signal that was thrown away by a premature category is not.

---

## 10. Collect broadly, filter later

A direct corollary of §9.

The system should:

1. **Collect** indicators (pre-upload and post-upload) broadly, with a low bar for inclusion. If something is observable and plausibly related to creative behavior or to outcome, it gets recorded.
2. **Filter** the set of indicators that are actually used as **prioritization metrics** — the indicators that drive what to do next, what to optimize for, what to surface to the creator — much more strictly, and only after evidence has accumulated.

These two activities live in different parts of the lifecycle and should not be confused. Confusing them in either direction is harmful:

- Filtering too early, at collection time, throws away the data that would have justified or invalidated the filter.
- Filtering too late, at decision time, lets weak indicators dominate decisions because they happened to be measured.

The filter for prioritization is not just "does this indicator correlate with the outcome." See §11.

---

## 11. Correlation is not optimization-worthiness

A subtle but critical point. An indicator can correlate strongly with the outcome and still be a **bad optimization target**.

The reason: an indicator is only useful as an optimization target to the degree that **acting on it changes creative behavior in a way that, in turn, changes the outcome.** If an indicator is correlated with the outcome but cannot be moved by any mechanism a creator has access to, optimizing for it is at best a measurement exercise and at worst actively misleading.

The full set of conditions for an indicator to be a useful optimization target:

1. It correlates with the outcome (necessary, not sufficient).
2. It can be **influenced** by mechanisms that the creator can actually execute.
3. Influencing it via those mechanisms produces a corresponding move in the outcome (i.e., the relationship is not purely epiphenomenal).
4. The cost of influencing it is reasonable relative to the size of the outcome move it produces.

The filter in §10 — the one that decides which indicators become prioritization metrics — must apply all four of these, not just the first.

This is also why mechanisms and principles are first-class layers in the architecture. Without them, there is no way to evaluate conditions 2–4. A purely indicator-and-outcome system can identify correlations but cannot tell which of those correlations are actionable.

---

## 12. How the layers connect

The layers are not just a stack; they form a graph.

- Mechanisms point to the pre-upload indicators they produce or modify.
- Mechanisms point (through the resulting content and its post-upload life) to the post-upload indicators they affect.
- Principles annotate the edges: each edge from a mechanism to an indicator carries a candidate explanation for why the edge exists and in what direction.
- Indicators (both pre and post) point to the outcome with a learned strength.
- Components decompose mechanisms; the same component can appear in many mechanism descriptions.
- Resolution is metadata on every node and every edge.

The whole thing is best thought of as a **causal-hypothesis graph** that the system grows over time. Nodes are observable things; edges are claims about how observable things move each other; principles are the textual content of those claims.

The graph is allowed to have:

- multiple competing principles on the same edge (the system does not have to pick one prematurely),
- the same node at multiple resolutions (with explicit links between resolutions),
- large gaps where mechanisms are recorded but no principle has been proposed yet,
- and indicators that are observed but not yet connected to any mechanism.

Gaps are not failures. Gaps are the system's to-do list.

---

## 13. The discovery loop

The system grows by repeatedly running a loop. The loop is the same regardless of which layer is currently being extended. Stated abstractly:

1. **Observe** a piece of content, a mechanism, an indicator, or a relationship.
2. **Record** it at whatever resolution it was observed, in whatever vocabulary fits.
3. **Connect** it to the existing graph: which existing nodes is it related to? Where does it sit in the layers?
4. **Hypothesize** a principle, if a new edge is being added: why does this relationship exist?
5. **Test** the hypothesis where possible — by predicting what should happen on new content, or by varying mechanisms and watching indicators move.
6. **Refine** the graph: strengthen confirmed edges, demote disconfirmed ones, lift recurring shapes into components, sharpen vocabulary.
7. **Re-prioritize** what to look at next based on the largest open gaps and the highest-value uncertainties.

The loop is the only mechanism by which categories become real in the system. Nothing in the loop requires a category to exist in advance.

---

## 14. Views (UI surfaces)

The UI is organized as views over the underlying graph. Each view is a particular projection of the graph that supports a particular kind of work. Views are read-mostly windows; the underlying graph is the source of truth.

The view types the system needs are organized around the layers and the loop, not around arbitrary product features:

- **Outcome view** — the master metric and its current state of explanation.
- **Indicator views** — pre-upload and post-upload indicators, each viewable at multiple resolutions, with their connections to the outcome and to each other.
- **Mechanism views** — the catalog of mechanisms, in whatever vocabulary they currently exist, with links to the indicators they affect.
- **Component views** — the emergent recurring sub-parts of mechanisms, surfaced as they accumulate.
- **Principle views** — the why-layer, organized by which edges in the graph they explain.
- **Resolution views** — the same indicator, mechanism, or principle viewed across resolutions, side by side.
- **Gap views** — what is *missing*: edges without principles, indicators without mechanisms, mechanisms without tests.
- **Meta-architecture view** — this document, kept alongside the rest of the system as the framework reference.

The views should not invent new categorizations. They should reflect the graph as it currently exists, including its messiness. If a view requires a category that does not yet exist in the graph, the right move is to extend the graph, not to hardcode the category in the view.

---

## 15. Build vision — immediate vs long-term

The current Jarvis implementation is closer to the immediate end of this spectrum than the long-term end. That is appropriate; the architecture is meant to be approached in stages.

### Immediate (where the system is now / next steps)

- A defined outcome metric.
- A growing set of post-upload indicators, recorded at varying resolutions.
- A growing set of pre-upload indicators, recorded broadly with a low bar for inclusion.
- Correlational analysis between indicators and the outcome, including multi-resolution slicing.
- Rough, free-text descriptions of mechanisms attached to specific pieces of content where possible.
- The meta-architecture (this document) available as a reference surface inside the system, so that future work stays aligned with the framework.

### Medium term

- Mechanism catalog accumulates enough volume that recurring shapes become visible.
- First emergent components are lifted out of the mechanism catalog by the system or by a human reviewer.
- Principles begin to be attached to the strongest indicator-to-outcome and mechanism-to-indicator edges.
- The prioritization filter from §10 / §11 is applied: a small subset of indicators is promoted to prioritization-metric status, the rest remain collected but not driving decisions.
- Resolution becomes navigable in the UI: the same node can be viewed across resolutions in one place.

### Long term

- The full causal-hypothesis graph is the operating object. Indicators, mechanisms, components, and principles are all first-class nodes, all connected, all multi-resolution.
- The discovery loop runs continuously and largely autonomously, with humans intervening at hypothesis-formation and principle-refinement steps.
- The system can take a candidate piece of content and, before upload, predict its outcome, point to the mechanisms responsible, and explain — via principles — what would change the prediction.
- Components form a stable enough vocabulary that mechanisms are routinely described in component terms and re-described as the vocabulary sharpens.
- Categories that emerged from the data are continuously re-evaluated as more data arrives; the system is willing to retire its own categories.

The long-term vision is not a fixed product. It is the steady state of the discovery loop running long enough that the graph becomes a useful map of the territory.

---

## 16. What this document is not

To prevent drift, a few clarifications about scope:

- This is **not** a list of indicators, mechanisms, components, or principles. Those live in the graph and grow over time. Putting them here would freeze them.
- This is **not** a schema. It is intentionally loose about how each layer is encoded, because the encoding should be allowed to evolve as the layers fill in.
- This is **not** a roadmap with deadlines. §15 sketches stages, not a timeline.
- This is **not** a constraint on the discovery loop. If observation suggests the architecture itself needs to change, the architecture changes. This document is a reference, not a contract.

The one thing this document *is* meant to lock in is the **stance**: outcome at the top, observation wide and shallow, explanation narrow and deep, categories emergent, resolution a first-class axis, and the gap between correlation and optimization-worthiness taken seriously.

Everything else is allowed to move.
