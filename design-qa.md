# Design QA

## Comparison target

- Source visual truth: `design-qa-evidence/reference-before-coupang-light.png` plus the approved Coupang Supplier Hub admin direction: light gray page background, white panels, thin gray borders, blue primary actions, compact squared controls, and restrained semantic colors.
- Implementation: `design-qa-evidence/implementation-coupang-light.png`.
- Focused evidence: `design-qa-evidence/implementation-coupang-light-lower.png` and `design-qa-evidence/interaction-coupang-light-advanced-open.png`.
- Route: `http://127.0.0.1:4310/fulfillment`.
- State: light theme, idle workflow, advanced recovery closed for the full-view comparison and open for the interaction check.

## Viewport and normalization

- CSS viewport: 1280 x 720.
- Source pixels: 1265 x 712 JPEG.
- Implementation pixels: 1265 x 712 JPEG.
- Device pixel ratio: 1.
- Density normalization: not required; source and implementation use the same browser surface, crop, pixel size, and density.

## Findings

- No remaining P0, P1, or P2 visual differences against the approved direction.
- Typography and copy: the existing Korean font stack, sizes, weights, labels, tool names, stage names, helper text, and button text are unchanged.
- Spacing and layout: all controls, cards, grid tracks, responsive breakpoints, and function positions remain unchanged.
- Surfaces: the page uses `#f5f6f8`, panels use white, and cards use flat 1px gray borders with 3-4px radii. Gradients, glow, and floating-card elevation are absent.
- Actions: execution buttons use Supplier Hub-style blue. Ordinary reset actions use amber, stage 13's destructive registration-key reset uses pale red, and stage 14's confirmation action uses pale blue.
- Image quality: the screen contains no raster product imagery, illustration, or logo assets, so no image-fidelity issue applies.

## Full-view comparison evidence

- `reference-before-coupang-light.png` captures the earlier dark industrial-console treatment.
- `implementation-coupang-light.png` confirms the approved light admin treatment while preserving the same layout and workflow controls.

## Focused region comparison evidence

- `implementation-coupang-light-lower.png` confirms all 16 stage execution buttons and all 16 reset buttons remain present and in place.
- Stage 11-16 actions use the same blue primary language without changing their behavior.
- Stage 13's `등록키+이력 초기화` and stage 14's `송장번호 확인` remain visually distinct from ordinary reset actions.
- `interaction-coupang-light-advanced-open.png` confirms the recovery section still expands correctly and its nested controls follow the same light visual system.

## Verification

- Primary interaction tested: advanced recovery section open/close control; it opened successfully.
- Browser console errors: none.
- Structural check: 16 stage cards, 16 stage execution buttons, and 16 stage reset buttons.
- Runtime: the startup-cached HTML was reloaded by restarting only the 4310 runtime through Runtime HUD; the 4311 Windows print MCP was left untouched.
- Computed styles: `color-scheme: light`, page background `#f5f6f8`, panel `#ffffff`, primary blue `#1677d2`, and stage radius `4px`.
- TypeScript build: passed.

## Follow-up polish

- P3: the primary blue can be deepened slightly later if a closer match to a specific current Supplier Hub screen is desired.

final result: passed
