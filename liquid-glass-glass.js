"use strict";(()=>{var se=`
// Corner style: 0 = circular (standard arc), 1 = continuous (squircle/superellipse).
// Declared here (in SDF_GLSL) because sdShape references it, and SDF_GLSL is
// included by multiple shaders (element, shadow, highlight, plain-rect).
uniform float uCornerStyle;

// --- Continuous-curvature SDF texture (capsule shape) ---
// When uUseContinuousSdf > 0.5, sdShape() dispatches to sdContinuousCurvature
// which samples a precomputed SDF texture (generated from the G2-continuous
// Bezier path in continuous-curve.ts). Only the dialog card sets this to 1;
// other shaders that include SDF_GLSL leave it at the default 0 \u2014 sdShape
// falls through to the analytic sdRoundedRect / sdContinuousRoundedRect path.
uniform sampler2D uContinuousSdf;
uniform float uUseContinuousSdf;        // 0 or 1
uniform float uNoContinuousSdfInRefraction;  // 0 or 1 \u2014 when 1, refraction/highlight SDF forces analytic sdRoundedRect (ignores uUseContinuousSdf). Mask/clip still uses uUseContinuousSdf.
uniform vec2  uContinuousSdfTexSize;    // SDF texture size in px (256, 256)
uniform vec2  uContinuousSdfElementSize; // element's original w,h in px

// radiusAt \u2014 picks the corner radius from cornerRadii based on which
// quadrant 'coord' is in. For uniform radii (the catalog case) this
// always returns the same value.
float radiusAt(vec2 coord, vec4 radii) {
    if (coord.x >= 0.0) {
        if (coord.y <= 0.0) return radii.y;
        else return radii.z;
    } else {
        if (coord.y <= 0.0) return radii.x;
        else return radii.w;
    }
}

// sdRoundedRect \u2014 signed distance to a rounded-rect boundary.
// Negative inside, positive outside, zero on the edge.
// Uses standard circular arcs for the corners.
float sdRoundedRect(vec2 coord, vec2 halfSize, float radius) {
    vec2 cornerCoord = abs(coord) - (halfSize - vec2(radius));
    float outside = length(max(cornerCoord, 0.0)) - radius;
    float inside = min(max(cornerCoord.x, cornerCoord.y), 0.0);
    return outside + inside;
}

// sdContinuousRoundedRect \u2014 continuous-curvature rounded rect.
// The original uses G2-continuous Bezier corners (ContinuousCurvatureRoundedRectangleCornerBuilder).
// The visual difference between Continuous and Circular is very subtle (only
// curvature continuity at the tangent points). For the SDF-based renderer,
// the circular arc SDF (sdRoundedRect) is a close enough approximation \u2014 the
// Bezier corners deviate from the arc by <0.5% of the radius, which is
// sub-pixel at typical element sizes.
//
// When uCornerStyle=1 (continuous), we use sdRoundedRect directly. The
// difference from the original is imperceptible. A future upgrade could
// implement exact Bezier SDF for pixel-perfect matching.
float sdContinuousRoundedRect(vec2 coord, vec2 halfSize, float radius) {
    return sdRoundedRect(coord, halfSize, radius);
}

// sampleClipMask \u2014 sample R channel (coverage) from the mask texture.
// Returns browser-native AA coverage [0,1] for clip + edgeAlpha.
float sampleClipMask(vec2 coord, vec2 halfSize, float radius) {
    float maxDim = max(max(uContinuousSdfElementSize.x, uContinuousSdfElementSize.y), 1e-4);
    float aspectW = uContinuousSdfElementSize.x / maxDim;
    float margin = 4.0;
    float drawW = (uContinuousSdfTexSize.x - 2.0 * margin) * aspectW;
    float scale = drawW / max(uContinuousSdfElementSize.x, 1e-4);
    vec2 tex = uContinuousSdfTexSize * 0.5 + coord * scale;
    vec2 uv = tex / uContinuousSdfTexSize;
    return texture2D(uContinuousSdf, uv).r;  // R = coverage [0,1]
}

// sampleClipSdf \u2014 sample G channel (SDF) from the mask texture.
// Returns signed distance: negative inside, positive outside, 0 at edge.
// Same shape as sampleClipMask (both from the same Bezier path), so clip
// and stroke shapes are always identical.
float sampleClipSdf(vec2 coord, vec2 halfSize, float radius) {
    float maxDim = max(max(uContinuousSdfElementSize.x, uContinuousSdfElementSize.y), 1e-4);
    float aspectW = uContinuousSdfElementSize.x / maxDim;
    float margin = 4.0;
    float drawW = (uContinuousSdfTexSize.x - 2.0 * margin) * aspectW;
    float scale = drawW / max(uContinuousSdfElementSize.x, 1e-4);
    vec2 tex = uContinuousSdfTexSize * 0.5 + coord * scale;
    vec2 uv = tex / uContinuousSdfTexSize;
    float g = texture2D(uContinuousSdf, uv).g;  // G = SDF [0,1]
    return (g * 2.0 - 1.0) * radius;  // decode to element-space distance
}

// sdClipShape \u2014 SDF for clip/discard when uUseContinuousSdf is OFF.
float sdClipShape(vec2 coord, vec2 halfSize, float radius) {
    return sdRoundedRect(coord, halfSize, radius);
}

// sdShape \u2014 SDF for refraction/highlight internal calculations.
// When uUseContinuousSdf=1 AND uNoContinuousSdfInRefraction=0, uses
// sampleClipSdf (same G2 shape as clip mask). Otherwise uses the analytic
// sdRoundedRect. This lets the "disable smooth SDF in glass" toggle strip
// the G2 SDF out of the refraction/lens computation while keeping the G2
// clip mask intact (capsuleShape still controls edge shape).
float sdShape(vec2 coord, vec2 halfSize, float radius) {
    if (uUseContinuousSdf > 0.5 && uNoContinuousSdfInRefraction < 0.5) {
        return sampleClipSdf(coord, halfSize, radius);
    }
    return sdRoundedRect(coord, halfSize, radius);
}

// gradSdRoundedRect \u2014 gradient of the SDF (points outward from edge).
// Used both for refraction direction and highlight specular.
vec2 gradSdRoundedRect(vec2 coord, vec2 halfSize, float radius) {
    vec2 cornerCoord = abs(coord) - (halfSize - vec2(radius));
    if (cornerCoord.x >= 0.0 || cornerCoord.y >= 0.0) {
        vec2 v = max(cornerCoord, vec2(0.0));
        // Guard against normalize(0,0) -> NaN
        float len = length(v);
        if (len < 1e-6) return vec2(0.0);
        return sign(coord) * (v / len);
    } else {
        float gradX = step(cornerCoord.y, cornerCoord.x);
        return sign(coord) * vec2(gradX, 1.0 - gradX);
    }
}

// rotateBy \u2014 rotate a 2D vector by angle (radians). Used to un-rotate the
// sample coord into the element's local space (so the SDF shape appears
// rotated by +uElementRotation), and to rotate refraction offsets back to
// screen space.
vec2 rotateBy(vec2 v, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}

// erfApprox \u2014 error function approximation (Abramowitz & Stegun 7.1.26).
// Max error < 2.5e-5. Used by inner shadow to model BlurMaskFilter's
// Gaussian convolution of a ring shape. erf(x) \u2208 [-1, 1].
float erfApprox(float x) {
    float a = abs(x);
    float t = 1.0 / (1.0 + 0.47047 * a);
    float y = 1.0 - (((0.3480242 * t - 0.0958798) * t + 0.7478556) * t * exp(-a * a));
    return sign(x) * y;
}
`,me=`
// Returns wallpaper UV for a canvas pixel coordinate (top-left origin).
vec2 coverUv(vec2 canvasPx) {
    float canvasAspect = uCanvasSize.x / uCanvasSize.y;
    float wpAspect = uWallpaperSize.x / uWallpaperSize.y;
    vec2 uv = canvasPx / uCanvasSize;
    if (wpAspect > canvasAspect) {
        // Wallpaper is wider than canvas \u2014 crop horizontally.
        float s = canvasAspect / wpAspect;
        uv.x = (uv.x - 0.5) * s + 0.5;
    } else {
        // Wallpaper is taller than canvas \u2014 crop vertically.
        float s = wpAspect / canvasAspect;
        uv.y = (uv.y - 0.5) * s + 0.5;
    }
    return uv;
}

// Per-axis scale: 1 canvas pixel in wallpaper UV units.
// Used to convert a blur radius (in canvas px) into UV-space offsets
// for poisson-disc sampling.
vec2 canvasPxToUvScale() {
    float canvasAspect = uCanvasSize.x / uCanvasSize.y;
    float wpAspect = uWallpaperSize.x / uWallpaperSize.y;
    if (wpAspect > canvasAspect) {
        return vec2(canvasAspect / wpAspect, 1.0) / uCanvasSize;
    } else {
        return vec2(1.0, wpAspect / canvasAspect) / uCanvasSize;
    }
}
`;var Wt=`
uniform sampler2D uBackdrop;
uniform sampler2D uWallpaperSampler;  // wallpaper texture (unscaled backdrop for toggle knobs)
uniform sampler2D uTabsBackdropSampler;  // tabsBackdrop FBO (tinted scene for indicator CombinedBackdrop)
uniform vec2  uCanvasSize;        // canvas size in px
uniform vec2  uWallpaperSize;     // wallpaper texture size; read by COVER_GLSL's coverUv()/canvasPxToUvScale() below \u2014 do NOT drop
uniform vec2  uElementOffset;     // element top-left in canvas px (SCALED rect \u2014 where the quad is drawn)
uniform vec2  uElementSize;       // element size in px (SCALED \u2014 includes graphicsLayer scaleX/scaleY)
uniform vec4  uBackdropBbox;      // (offsetX, offsetY, sizeX, sizeY) in UV [0,1] \u2014 region of fullscreen scene the backdrop texture covers. Identity (0,0,1,1) when fullscreen.
uniform vec4  uCornerRadii;       // (topLeft, topRight, bottomRight, bottomLeft) in px (ORIGINAL, unscaled)
uniform float uRefractionHeight;  // px (ORIGINAL space \u2014 NOT scaled by layerScale, faithful to AGSL)
uniform float uRefractionAmount;  // px (ORIGINAL space \u2014 NOT scaled, faithful to AGSL)
// --- Layer transform (faithful to graphicsLayer { scaleX, scaleY }) ---
// The original applies the refraction shader at the ORIGINAL element size, THEN
// scales the entire rendered layer by (scaleX, scaleY) via graphicsLayer. To
// replicate this in a single-pass shader, we compute the SDF/refraction in
// ORIGINAL space (by dividing the screen-space centered coord by uLayerScale),
// then map the refraction offset back to screen space for backdrop sampling.
// This keeps the SDF shape correct (not stretched) while covering the scaled rect.
uniform vec2  uOriginalSize;        // element size in px (ORIGINAL, unscaled by graphicsLayer)
uniform float uOriginalCornerRadius; // corner radius in px (ORIGINAL, unscaled)
uniform vec2  uLayerScale;          // (scaleX, scaleY) from graphicsLayer \u2014 maps original\u2192screen
uniform float uElementRotation;    // rotation in radians (graphicsLayer rotationZ) \u2014 0 = none
uniform float uDepthEffect;       // 0 or 1
uniform float uChromaticAberration; // 0 or 1
uniform float uBlurRadius;        // px
uniform float uSaturation;        // vibrancy = 1.5
uniform float uBrightness;        // brightness offset (0 for vibrancy)
uniform float uContrast;          // 1.0 for vibrancy
uniform vec4  uTintColor;         // rgba; alpha 0 = no tint
uniform vec4  uSurfaceColor;      // rgba; alpha 0 = no surface
uniform vec4  uHighlightColor;    // rgb + 1.0 (alpha handled by uHighlightAlpha)
uniform float uHighlightAngle;    // radians
uniform float uHighlightFalloff;
uniform float uHighlightAlpha;
uniform float uHighlightMode;     // 0=default, 1=ambient, 2=plain
uniform float uHighlightStrokeWidth; // px (full stroke width, matching paint.strokeWidth)
uniform float uHighlightBlur;     // px (BlurMaskFilter radius)
// Content scale (non-uniform, faithful to LiquidToggle.kt / LiquidSlider.kt):
//   scale(scaleX, scaleY) { drawBackdrop() }
// Toggle: X lerp(2/3, 0.75, p), Y lerp(0, 0.75, p)
// Slider: X lerp(2/3, 1, p),    Y lerp(0, 1, p)
// At rest Y=0 \u2192 backdrop sampled from a single horizontal line (degenerate),
// but the white overlay (alpha=1) hides it. When pressed, scales to full.
uniform float uContentScaleX;
uniform float uContentScaleY;
// --- Toggle knob CombinedBackdrop effect (faithful to LiquidToggle.kt) ---
// The knob's backdrop is a CombinedBackdrop of:
//   1. Outer backdrop (LayerBackdrop wallpaper OR CanvasBackdrop solid color)
//   2. Scaled trackBackdrop (track color rect, scaled by lerp(2/3,0.75) x lerp(0,0.75))
// uUseToggleBackdrop = 1.0 \u2192 sample outer backdrop + composite scaled track color
// uUseToggleBackdrop = 0.0 \u2192 sample scene (uBackdrop) as before
//
// uUseSolidBackdrop = 1.0 \u2192 outer backdrop is solid color (uSolidBackdropColor)
// uUseSolidBackdrop = 0.0 \u2192 outer backdrop is wallpaper texture (uWallpaperSampler)
// Faithful to ToggleContent.kt:
//   - t1 (on wallpaper): backdrop = LayerBackdrop \u2192 sample wallpaper texture
//   - t2 (on card):      backdrop = rememberCanvasBackdrop { drawRect(color) } \u2192 solid color
uniform float uUseToggleBackdrop;
uniform float uUseSolidBackdrop;
uniform vec4  uSolidBackdropColor;  // rgba 0..1; used when uUseSolidBackdrop = 1.0
uniform vec4  uTrackColor;        // rgba 0..1; alpha 0 = no track color
uniform vec4  uTrackRect;         // (centerX, centerY, halfW, halfH) in canvas px (dpr-scaled)
uniform float uTrackCornerRadius; // canvas px (dpr-scaled)
// --- Bottom tab \u6307\u793A\u5668 CombinedBackdrop (faithful to LiquidBottomTabs.kt) ---
// The \u6307\u793A\u5668's backdrop = CombinedBackdrop(wallpaper, \u5185\u5C42\u80CC\u666F\u677F) where
// \u5185\u5C42\u80CC\u666F\u677F (tabsBackdrop) is a hidden Row with ColorFilter.tint(accentColor). Only the
// opaque \u6807\u7B7E\u5185\u5BB9 (icons/labels) becomes blue after tint \u2014 the glass part
// is transparent. We pass up to 8 tab content rects; pixels inside any rect
// (clipped to the \u5BB9\u5668 capsule) are tinted accentColor.
uniform float uIndicatorBackdrop;    // 0 or 1
uniform vec4  uContainerRect;        // (centerX, centerY, halfW, halfH) in canvas px (dpr-scaled)
uniform float uContainerCornerRadius; // canvas px (dpr-scaled)
uniform vec4  uIndicatorAccent;      // (r, g, b, a) \u2014 accentColor + unused
uniform float uInsetPx;              // indicator backdrop inset in device px (4dp * dpr)
uniform float uIndicatorPressProgress; // 0..1 press progress (for 2nd-layer scale)
uniform float uIndicatorPanelOffset; // panel offset in device px (2nd-layer x translation)
uniform float uDpr;                 // device pixel ratio (for dp\u2192px conversion)
uniform vec2  uContainerCenter;      // container center (scale origin) in canvas px (dpr-scaled)
uniform float uContainerScale;       // container layerBlock scale (1 + 16dp/width * pressProgress)
// Tab content fgTextures (icon+label alpha masks) for blue tint. Up to 8 tabs.
// Only opaque icon/label pixels become blue \u2014 the container glass stays natural.
uniform sampler2D uTabContentTex0;
uniform sampler2D uTabContentTex1;
uniform sampler2D uTabContentTex2;
uniform sampler2D uTabContentTex3;
uniform sampler2D uTabContentTex4;
uniform sampler2D uTabContentTex5;
uniform sampler2D uTabContentTex6;
uniform sampler2D uTabContentTex7;
uniform vec4  uTabContentRects[8];   // (centerX, centerY, halfW, halfH) per tab, canvas px (dpr-scaled)
uniform float uTabContentCount;      // number of valid tab rects (0..8)
uniform sampler2D uTabsGlassLayer;   // scene snapshot BEFORE tab-content (wallpaper+glass only, no text)
// --- SDF texture glass (faithful to SdfShader.kt) ---
uniform sampler2D uSdfTexSampler;   // clock_sdf texture (R=SDF, GB=normal, A=shape alpha)
uniform float uUseSdfTexture;       // 0 or 1
uniform vec2  uSdfTexSize;          // texture natural dimensions (px)
uniform float uSdfLightAngle;       // bevel light angle (degrees)
uniform float uEnterAlpha;          // global element alpha (enterProgress, 0..1)
// Highlight generation distance multiplier. The SDF-texture shader computes
// intensity = circleMap(1.0 - min(1.0, -sd * uSdfHighlightScale)) where sd is
// the normalized signed distance (-1 deep inside, 0 at edge, +1 far outside).
// The intensity field drives BOTH the refraction offset AND the bevel-lighting
// contribution. Physically it controls the WIDTH of the edge band where the
// glass effect transitions from full (at the edge) to zero (interior):
//   higher scale = narrower/sharper edge band (thinner glass edge feel)
//   lower scale  = wider/gentler edge band (thicker glass edge feel)
// Exposed as "\u73BB\u7483\u539A\u5EA6" (glass thickness) in the TextGlass UI. Default 1.5
// matches the original hardcoded constant in SdfShader.kt.
uniform float uSdfHighlightScale;   // default 1.5
// Bevel lighting on/off (0 or 1). When 0, the shader still computes
// intensity (so refraction \u2014 the glass distortion of the backdrop \u2014 still
// uses uSdfHighlightScale and stays fully adjustable), but the BEVEL
// brightness contribution (color *= 1 + 0.5 * intensity * bevel) is
// skipped entirely. This lets the TextGlass \u5149\u5F71 toggle turn the
// light/shadow layer on/off WITHOUT zeroing the thickness slider's shader
// value (so the slider is never dead). The base brightness dim (\u22120.1) is
// controlled separately via uBrightness on the JS side.
uniform float uSdfBevelEnabled;     // default 1 (on)
// Whole-glass tint dye hue (0..360 degrees). The TextGlass \u67D3\u8272 slider picks
// a hue; the ENTIRE glass body takes on that hue via BlendMode.Hue (faithful
// to Skia's non-separable Hue blend: result takes hue from the tint src, keeps
// the glass's own saturation + value). This is NOT a flat color overlay or CSS
// hue-rotate filter \u2014 it's a proper hue replacement that preserves the glass's
// luminance and saturation, so a dyed glass still looks like glass, just tinted.
// 0 = OFF (no tint \u2014 the slider's leftmost position). 1..360 = hue degrees
// (1 = red-ish, 120 = green, 240 = blue, 360 = red). The off-state is checked
// via uSdfGlassTintHue > 0.5 so the slider's leftmost (0) disables the tint
// entirely. Independent of the \u5149\u5F71 (bevel) toggle \u2014 dyes the whole glass body
// regardless of whether the edge lighting layer is on.
uniform float uSdfGlassTintHue;     // default 0 (off); 1..360 = hue
// Glass tint master switch (0 or 1). Gates BOTH the color-mix filter (below)
// AND the hue-dye (above). When OFF, no tint of any kind is applied regardless
// of uSdfGlassTintHue / uSdfGlassTintMix. Faithful to "\u67D3\u8272\u52A0\u4E00\u4E2A\u5F00\u5173".
uniform float uSdfGlassTintEnabled; // default 0 (off)
// Color-mix filter strength (0..1). BEFORE the hue-dye, the glass body is
// mixed toward a flat color (the pure saturated hue color) by this amount.
// This is a "color mix" filter (SrcOver-style blend toward a solid color) \u2014
// distinct from the hue-dye which replaces hue but preserves S/V. 0 = no
// color-mix (only the hue-dye applies); 1 = full color overlay. Faithful to
// "\u67D3\u8272\u524D\u52A0\u4E00\u4E2A\u6EE4\u955C\uFF08\u989C\u8272\u6DF7\u5408\uFF09\u6DF7\u5408\u5F3A\u5EA6\u8981\u53EF\u4EE5\u8C03".
uniform float uSdfGlassTintMix;     // default 0 (off); 0..1 = mix strength
// Hue-dye strength (0..1, default 0.85). Controls how strongly the
// BlendMode.Hue dye is applied to the glass body. 0 = no hue-dye (only the
// color-mix filter applies if any); 1 = full hue replacement. Originally
// hardcoded at 0.85 (matching the original's constant), now exposed as a
// slider so the user can tune the dye intensity independently of the
// color-mix filter. Faithful to "\u52A0\u4E00\u4E2A\u8C03\u67D3\u8272\u5F3A\u5EA6\u7684".
uniform float uSdfGlassTintStrength; // default 0.85; 0..1 = dye strength
// Tint color saturation (0..1, default 1.0). The tint source color is
// hsv2rgb(hue/360, S, V); S was hardcoded 1.0 before. 0 = gray, 1 = full.
uniform float uSdfGlassTintSaturation; // default 1.0; 0..1
// Tint color lightness/value (0..1, default 1.0). The V in hsv2rgb.
// 0 = black, 0.5 = mid, 1 = full brightness.
uniform float uSdfGlassTintLightness;  // default 1.0; 0..1
// Edge matte (0 or 1). When 1, the SDF edge band (where intensity is high,
// i.e. near the text boundary) is desaturated toward luminance AND slightly
// darkened \u2014 a frosted/matte rim. The edge band factor is intensity itself
// (1 at the very edge, 0 in the interior), so the matte effect fades smoothly
// into the clear glass interior. Faithful to the user request: "\u7528sdf\u6E32\u67D3\u8FB9\u7F18\uFF0C
// \u7136\u540E\u7ED9\u8FB9\u7F18\u964D\u4F4E\u63D0\u4EAE\u4E0E\u9971\u548C\u5EA6" (render the edge with SDF, then reduce the
// edge's brightness and saturation). Independent of the bevel toggle.
uniform float uSdfEdgeMatteEnabled; // default 0 (off)
// Edge matte target bitmask (default 7 = all). Controls WHICH layers the
// matte desaturate+darken applies to. bit 0 (1) = bevel (\u5149\u5F71 highlight),
// bit 1 (2) = tint (\u67D3\u8272), bit 2 (4) = base (refraction/body). When a bit is
// unset, that layer's edge contribution is preserved (not matted). The
// shader checks each bit independently so the user can matte only the bevel
// edge, or only the tint edge, etc. Faithful to "\u54D1\u5149\u5C42\u53EF\u4EE5\u8C03\u662F\u5426\u4F5C\u7528\u4E8E\u67D0
// \u4E9B\u5C42" (the matte layer can be tuned to apply to certain layers).
uniform float uSdfEdgeMatteTargets; // default 7 (all three layers)
// Per-layer matte tuning parameters. Each vec2 = (range, min):
//   range (0..1, default 1.0) \u2014 how far the matte effect extends from the
//     text boundary inward. 1.0 = the matte fades across the FULL intensity
//     field (edge = full strength, interior = zero, original behavior);
//     0.5 = the matte reaches full strength at intensity=0.5 and stays full
//     for intensity > 0.5 (a sharper/narrower matte band right at the rim);
//     small values = very thin matte rim. The edge factor is computed as
//     clamp(intensity / max(range, 0.001), 0.0, 1.0).
//   min (0..1, default 0.0) \u2014 minimum matte amount applied even in the deep
//     interior (where intensity \u2192 0). 0 = interior is clear (no matte);
//     0.3 = interior always has at least 30% matte. The final edge factor is
//     edgeClamped * (1.0 - min) + min. Faithful to "\u7ED9\u54D1\u5149\u6BCF\u5C42\u52A0\u4E0A\u4F5C\u7528\u53C2\u6570
//     \u8C03\u8282\uFF0C\u6BD4\u5982\u8303\u56F4\uFF0C\u6700\u5C0F\u503C".
// One vec2 per layer: bevel (bit 0), tint (bit 1), base (bit 2), brighten
// (bit 3). When the overall uSdfEdgeMatteEnabled is OFF, these are ignored.
// When a layer's bit in uSdfEdgeMatteTargets is unset, that layer's params
// are also ignored.
uniform vec2  uSdfEdgeMatteBevelParams; // (range, min) for bevel layer
uniform vec2  uSdfEdgeMatteTintParams;  // (range, min) for tint layer
uniform vec2  uSdfEdgeMatteBaseParams;  // (range, min) for base layer
uniform vec2  uSdfEdgeMatteBrightenParams; // (range, min) for brighten layer
// Per-layer matte STRENGTH (0..2, default 1.0). Scales the desaturate amount
// (matteStrength 0.65) AND the darken amount (matteDarken 0.18) for that
// layer. 0 = no matte effect at all (even at full edge); 1 = original
// strength; 2 = doubled. Independent per layer so the user can crank the
// bevel matte without affecting the tint/base matte. Faithful to "\u8C03\u6574\u63D0\u4EAE
// \u5C42\u54D1\u5149\u7684".
uniform float uSdfEdgeMatteBevelStrength; // default 1.0
uniform float uSdfEdgeMatteTintStrength;  // default 1.0
uniform float uSdfEdgeMatteBaseStrength;  // default 1.0
uniform float uSdfEdgeMatteBrightenStrength; // default 1.0
// Raw SDF debug render \u2014 when > 0.5, the SDF-texture glass path bypasses all
// glass effects and outputs the SDF's R channel directly as grayscale
// (inside = white, outside = black, AA via A channel). Used by TextGlass to
// inspect texture quality / aliasing / padding.
uniform float uSdfDebugMode;        // 0 or 1
// Coverage (A channel) \u2192 mask smoothstep range. The clock_sdf.webp texture
// uses (0.5, 1.0) \u2014 its A channel is 0 outside, 255 inside with a 1px AA
// edge, so smoothstep(0.5, 1.0) gives a 0.5px AA edge. The text SDF texture
// stores the raw Canvas2D alpha (0..255 with a 1-2px AA edge); using
// (0.5, 1.0) clips the lower half of the AA range \u2192 hard aliased edges,
// especially on small text. For text SDF, we widen to (0.0, 1.0) so the
// full Canvas2D AA gradient is preserved \u2192 smooth edges at all sizes.
uniform float uSdfAaMin;            // default 0.5 (clock_sdf); 0.0 for text SDF
// --- Per-element FBO optimization ---
// When uUsePerElementFbo > 0.5, the element is being rendered into a small
// bbox-sized FBO (NOT the fullscreen scene FBO). In that case gl_FragCoord
// ranges over [0..uElFboSize], so screenCoord must be reconstructed as
// uSceneRectOffset + (gl_FragCoord with Y flipped by uElFboSize.y) to map
// back into the full-canvas top-left-origin coordinate space that the rest
// of the shader (sampleBackdrop, coverUv, SDF, etc.) expects.
uniform float uUsePerElementFbo;    // 0 or 1
uniform vec2  uSceneRectOffset;     // element bbox top-left in canvas px (top-left origin, device px)
uniform vec2  uElFboSize;           // per-element FBO size in device px
// DEPRECATED: uBackdropRect was used by the old PEF path that sampled a
// cropped backdrop texture. The current PEF path samples the FULLSCREEN
// scene texture (same as ping-pong), so sceneUv no longer reads this.
// Kept in the uniform list for cache-index compatibility; not referenced
// by any shader code. Safe to remove once the uniform-cache list is cleaned.
uniform vec4  uBackdropRect;        // (x, y, w, h) top-left origin, scene device px (UNUSED)
// When 1.0, skip applyColorControls in the element shader (colorControls was
// already applied as a fullscreen pass BEFORE the 2-pass blur on the backdrop
// FBO, matching the original's colorControls\u2192blur\u2192lens order). Used by
// backdropFbo + useSeparableBlur elements (dialog card).
uniform float uSkipColorControls;   // 0 or 1
// (uNoContinuousSdfInRefraction is declared in SDF_GLSL \u2014 included by element.ts.
//  When 1.0, the refraction/lens computation forces analytic sdRoundedRect,
//  stripping the G2 SDF texture out of the glass-body refraction. The clip
//  mask is NOT affected \u2014 capsuleShape still controls the edge.)
// --- Magnifier glass (faithful to MagnifierContent.kt) ---
uniform float uUseMagnifier;        // 0 or 1
uniform float uMagnifierZoom;       // zoom factor (1.5)
uniform float uMagnifierOffsetY;    // sample Y offset to cursor (80dp, device px)
// --- Sample wallpaper directly (bypass scene FBO) ---
// When 1.0, sampleBackdrop uses coverUv + uWallpaperSampler (clean wallpaper)
// instead of sceneUv + uBackdrop (scene FBO). Used by elements that sit over
// a scrim/dim (Dialog card, ControlCenter tiles) so the glass refracts the
// clean wallpaper instead of the alpha-decayed scene FBO. Faithful to the
// original where LayerBackdrop captures the wallpaper Image (alpha=1).
uniform float uSampleWallpaper;     // 0 or 1
// --- Scrim color (applied to the wallpaper BEFORE colorControls/blur/lens) ---
// Faithful to DialogContent.kt / ControlCenterContent.kt where the scrim
// (drawRect(dimColor)) is painted onto the wallpaper Image (via
// BackdropDemoScaffold's modifier = drawWithContent { drawContent(); drawRect(dimColor) }),
// so the LayerBackdrop captures wallpaper+scrim as one opaque layer.
// In the port, when uSampleWallpaper=1 (clean wallpaper), we apply the scrim
// here in the shader to replicate that composited backdrop. uScrimColor.a=0
// means no scrim. Applied as SrcOver: backdrop.rgb = scrim.rgb*scrim.a + backdrop.rgb*(1-scrim.a).
uniform vec4 uScrimColor;           // rgba 0..1; a=0 = no scrim
// --- \u5185\u5C42\u80CC\u666F\u677F rim highlight stroke mask (Canvas2D, same approach as outer rim) ---
// When uIndicatorBackdrop=1, the inner backdrop plate's rim highlight is sampled
// from this pre-rasterized Canvas2D stroke mask instead of computed analytically.
// The mask is drawn for the \u5185\u5C42\u80CC\u666F\u677F capsule shape (uContainerRect dimensions)
// with clip(stroke) + BlurMaskFilter, giving browser-native Skia AA.
uniform sampler2D uInnerStrokeMask;   // Canvas2D stroke mask texture for inner backdrop highlight
uniform vec2  uInnerStrokeMaskOffset; // margin (strokeMargin) in device px \u2014 UV offset
uniform vec2  uInnerStrokeMaskSize;   // (maskW, maskH) in device px \u2014 total mask texture size
`;function jr(e){let r=[];if(e<=1)return r.push({x:0,y:0,w:1}),r;let t=Math.PI*(3-Math.sqrt(5)),s=3,a=0;for(let o=0;o<e;o++){let n=(o+.5)/e,i=s*Math.sqrt(n),l=o*t,d=i*Math.cos(l),c=i*Math.sin(l),u=d*d+c*c,h=Math.exp(-.5*u);r.push({x:d,y:c,w:h}),a+=h}if(a>0)for(let o of r)o.w/=a;return r}function Nt(e,r,t,s){if(e.length===1)return`    return texture2D(${r}, ${t});
`;let a="";for(let o of e){let n=o.x.toFixed(6),i=o.y.toFixed(6),l=o.w.toFixed(8);a+=`    sum += texture2D(${r}, ${t} + vec2(${n}, ${i}) * ${s}) * ${l};
`}return a}var Ge=16;function Xt(e=Ge){let r=jr(e),t=Nt(r,"uBackdrop","uv","pxToUv"),s=Nt(r,"uWallpaperSampler","uv","pxToUv");return`
// Forward declarations \u2014 blendHue/rgb2hsv/hsv2rgb are defined later but used
// by sampleIndicatorBackdrop (which must come before sampleToggleBackdrop in
// the file for readability). GLSL ES 1.00 requires declaration before use.
vec3 rgb2hsv(vec3 c);
vec3 hsv2rgb(vec3 c);
vec3 hsl2rgb(vec3 c);
vec3 blendHue(vec3 dst, vec3 src);

float circleMap(float x) {
    return 1.0 - sqrt(1.0 - x * x);
}

// SDF-texture glass sampling (faithful to SdfShader.kt).
// Samples the clock_sdf texture at element-local coords.
// Returns vec4(intensity, maskAlpha, normalX, normalY); zeroes if outside.
//
// uSdfHighlightScale controls how far from the text edge the bevel highlight
// extends into the interior. Original hardcoded constant was 1.5; exposed as
// a uniform so the TextGlass page can tune it live via a slider.
//
// uSdfAaMin controls the coverage\u2192mask smoothstep lower bound. clock_sdf uses
// 0.5 (narrow AA); text SDF uses 0.0 (full Canvas2D AA gradient \u2192 smooth at
// all sizes, no aliasing on small text).
vec4 sampleSdfTexture(vec2 localPx) {
    vec2 uv = vec2(localPx.x / uOriginalSize.x,
                   localPx.y / uOriginalSize.y);
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
        return vec4(0.0);
    }
    vec4 v = texture2D(uSdfTexSampler, uv);
    float sd = v.r * 2.0 - 1.0;
    float mask = smoothstep(uSdfAaMin, 1.0, v.a);
    if (mask <= 0.0) return vec4(0.0);
    if (mask < 1.0) sd = 0.0;
    vec2 normal = normalize(v.gb * 2.0 - 1.0);
    float intensity = circleMap(1.0 - min(1.0, -sd * uSdfHighlightScale));
    return vec4(intensity, mask, normal.x, normal.y);
}

// Convert a canvas-pixel coordinate (top-left origin) to scene-texture UV.
// The scene texture is the same size as the canvas, and is rendered with
// gl_FragCoord (bottom-left origin). So UV = (canvasPx.x / canvasW, 1 -
// canvasPx.y / canvasH). The Y flip happens here so the rest of the shader
// can work in top-left-origin canvas px.
//
// This is used by BOTH the ping-pong path and the per-element FBO path.
// In the PEF path, the element pass still samples the FULLSCREEN scene
// texture (uBackdrop = curTex or blurFboBTex), NOT a cropped region. The
// only PEF-specific work happens in element.ts's main(), where screenCoord
// is reconstructed from gl_FragCoord via uSceneRectOffset/uElFboSize. Once
// screenCoord is in canvas-px space, this function maps it to UV identically
// for both paths \u2014 keeping the shader's non-local reads (refraction offset,
// chromatic 7-tap spread, blur kernel) hitting real neighbor content.
vec2 sceneUv(vec2 canvasPx) {
    return vec2(canvasPx.x / uCanvasSize.x, 1.0 - canvasPx.y / uCanvasSize.y);
}

// Gaussian disc blur \u2014 ${e} taps, dynamically generated in JS.
// Offsets are in units of radius (sigma = radius), scaled at runtime.
// radius < 0.5 falls back to single tap (no visible blur).
//
// When uSampleWallpaper > 0.5, samples the CLEAN wallpaper (uWallpaperSampler
// via coverUv) instead of the scene FBO (uBackdrop via sceneUv), AND applies
// the scrim (uScrimColor) to replicate the original's wallpaper+scrim composited
// LayerBackdrop. The scrim is applied INSIDE sampleBackdrop so EVERY sampling
// site \u2014 the initial backdrop sample, the refraction re-sample, and each
// chromatic-aberration channel \u2014 gets the same wallpaper+scrim composite.
// This fixes the "scrim not applied at edges" bug where the refraction band
// re-sampled the clean wallpaper (without scrim), making the edge brighter
// than the interior.
vec4 sampleBackdrop(vec2 canvasPx, float radius) {
    if (uSampleWallpaper > 0.5) {
        vec2 uv = coverUv(canvasPx);
        vec4 c;
        if (radius < 0.5) {
            c = texture2D(uWallpaperSampler, uv);
        } else {
            vec2 pxToUv = radius * canvasPxToUvScale();
            vec4 sum = vec4(0.0);
${s}            c = sum;
        }
        // Apply scrim (SrcOver) so the backdrop = wallpaper+scrim, opaque.
        if (uScrimColor.a > 0.001) {
            c.rgb = uScrimColor.rgb * uScrimColor.a + c.rgb * (1.0 - uScrimColor.a);
            c.a = 1.0;
        }
        return c;
    }
    vec2 uv = sceneUv(canvasPx);
    // uBackdrop may be a bbox-sized texture (when blur ran in a bbox FBO via
    // cropAndBlurBackdrop). uBackdropBbox = (offsetX, offsetY, sizeX, sizeY)
    // in normalized UV [0,1] \u2014 the region of the fullscreen scene the bbox
    // texture covers. Map sceneUv into that region, clamp to avoid bleeding
    // at bbox edges. When uBackdropBbox.zw > 1.0 (sentinel = fullscreen),
    // the mapping is identity (uv unchanged).
    uv = (uv - uBackdropBbox.xy) / uBackdropBbox.zw;
    uv = clamp(uv, vec2(0.0), vec2(1.0));
    if (radius < 0.5) {
        return texture2D(uBackdrop, uv);
    }
    // Backdrop is always the fullscreen scene texture (both ping-pong and
    // PEF paths), so blur offsets scale by the canvas size.
    vec2 pxToUv = radius / uCanvasSize;
    vec4 sum = vec4(0.0);
${t}    return sum;
}

// Gaussian disc blur of the WALLPAPER (uWallpaperSampler via coverUv).
// Used by the SDF-texture glass path (LockScreen) \u2014 faithful to the original's
// blur(2dp) effect applied before the SDF shader.
vec4 sampleWallpaperBlurred(vec2 canvasPx, float radius) {
    vec2 uv = coverUv(canvasPx);
    if (radius < 0.5) {
        return texture2D(uWallpaperSampler, uv);
    }
    vec2 pxToUv = radius * canvasPxToUvScale();
    vec4 sum = vec4(0.0);
${s}    return sum;
}

// --- Toggle knob CombinedBackdrop sampling (faithful to LiquidToggle.kt) ---
// The knob's backdrop is a CombinedBackdrop of:
//   1. Outer backdrop:
//      - LayerBackdrop (wallpaper) for t1 \u2192 sample uWallpaperSampler
//      - CanvasBackdrop (solid color) for t2 \u2192 use uSolidBackdropColor
//   2. Scaled trackBackdrop (track color rect, clipped to Capsule, scaled
//      by lerp(2/3, 0.75, pressProgress) x lerp(0, 0.75, pressProgress)
//      around the knob's center)
//
// This function samples the outer backdrop (wallpaper OR solid color) with blur,
// then composites the scaled track color on top using a rounded-rect SDF
// at the uTrackRect position (center + half-size + corner radius).
//
// The track color SDF is also blurred by approximating the blur as a
// smoothstep over uBlurRadius \u2014 this matches the original where the blur
// effect is applied to the CombinedBackdrop (outer + track color).
vec4 sampleToggleBackdrop(vec2 canvasPx, float radius) {
    // 1. Sample outer backdrop with blur.
    vec4 wp;
    if (uUseSolidBackdrop > 0.5) {
        // CanvasBackdrop case (t2): solid color fills the entire knob area.
        // Faithful to: rememberCanvasBackdrop { drawRect(backgroundColor) }
        // The drawRect fills the DrawScope (knob's bounds) with the color,
        // so every pixel of the knob's backdrop is the solid color.
        wp = uSolidBackdropColor;
    } else if (radius < 0.5) {
        // LayerBackdrop case (t1): sample wallpaper texture unscaled.
        // IMPORTANT: use coverUv (cover-fit) to match the wallpaper background
        // pass (WALLPAPER_FRAGMENT_SHADER). Using sceneUv (raw normalization)
        // here would sample the wrong texel when the wallpaper aspect ratio
        // differs from the canvas \u2014 causing the knob to see a shifted/misaligned
        // wallpaper that doesn't match what's displayed behind it.
        vec2 uv = coverUv(canvasPx);
        wp = texture2D(uWallpaperSampler, uv);
    } else {
        // LayerBackdrop case (t1) with blur: 9-tap poisson disc on wallpaper.
        // Use coverUv for the center sample, and convert the blur radius from
        // canvas px to UV-space using canvasPxToUvScale() (which accounts for
        // the cover-fit aspect ratio cropping).
        vec2 uv = coverUv(canvasPx);
        vec2 pxToUv = radius * canvasPxToUvScale();
        vec4 sum = vec4(0.0);
        float total = 0.0;
        sum += texture2D(uWallpaperSampler, uv) * 0.25; total += 0.25;
        sum += texture2D(uWallpaperSampler, uv + vec2( 1.000,  0.000) * pxToUv) * 0.12; total += 0.12;
        sum += texture2D(uWallpaperSampler, uv + vec2(-1.000,  0.000) * pxToUv) * 0.12; total += 0.12;
        sum += texture2D(uWallpaperSampler, uv + vec2( 0.000,  1.000) * pxToUv) * 0.12; total += 0.12;
        sum += texture2D(uWallpaperSampler, uv + vec2( 0.000, -1.000) * pxToUv) * 0.12; total += 0.12;
        sum += texture2D(uWallpaperSampler, uv + vec2( 0.707,  0.707) * pxToUv) * 0.0675; total += 0.0675;
        sum += texture2D(uWallpaperSampler, uv + vec2( 0.707, -0.707) * pxToUv) * 0.0675; total += 0.0675;
        sum += texture2D(uWallpaperSampler, uv + vec2(-0.707,  0.707) * pxToUv) * 0.0675; total += 0.0675;
        sum += texture2D(uWallpaperSampler, uv + vec2(-0.707, -0.707) * pxToUv) * 0.0675; total += 0.0675;
        wp = sum / total;
    }

    // 2. Composite scaled track color on top.
    // The track rect is centered at uTrackRect.xy with half-size uTrackRect.zw,
    // and corner radius uTrackCornerRadius. We compute the SDF of this
    // rounded rect at canvasPx, then apply a smoothstep for edge AA + blur.
    // If uTrackColor.a == 0.0 OR the track rect is degenerate (halfW or
    // halfH < 0.5px, which happens at rest when scaleY=0), skip compositing.
    // Faithful to original: scale(scaleX, 0) { drawRect() } draws nothing.
    if (uTrackColor.a > 0.001 && uTrackRect.z > 0.5 && uTrackRect.w > 0.5) {
        vec2 trackCenter = uTrackRect.xy;
        vec2 trackHalf = uTrackRect.zw;
        vec2 trackLocal = canvasPx - trackCenter;
        // sdRoundedRect expects centered coord (relative to center).
        // Use uniform corner radius = uTrackCornerRadius.
        float tr = uTrackCornerRadius;
        // Approximate the rounded-rect SDF (matches sdRoundedRect from SDF_GLSL).
        vec2 q = abs(trackLocal) - trackHalf + vec2(tr);
        float trackSd = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - tr;
        // Blur the edge by uBlurRadius (approximate Gaussian edge feather).
        // Inside (trackSd < -radius) \u2192 mask=1; outside (trackSd > radius) \u2192 mask=0.
        // Use max(radius, 1.0) to guarantee at least 1px smoothstep for AA
        // \u2014 when fully pressed, blurRadius=0, but edges must still be smooth.
        float aaRadius = max(radius, 1.0);
        float mask = 1.0 - smoothstep(-aaRadius, aaRadius, trackSd);
        // Composite: srcOver (track color over outer backdrop).
        float a = mask * uTrackColor.a;
        wp.rgb = mix(wp.rgb, uTrackColor.rgb, a);
        wp.a = mix(wp.a, 1.0, a);
    }
    return wp;
}

// sampleIndicatorBackdrop \u2014 faithful to LiquidBottomTabs.kt indicator.
//
// Naming convention (used throughout the bottom-tabs code):
//   - \u5BB9\u5668 (Container)  = outer visible glass bar (64dp), Container Row in Kotlin
//   - \u6307\u793A\u5668 (Indicator) = selected sliding glass capsule (56dp), Indicator Box in Kotlin
//   - \u5185\u5C42\u80CC\u666F\u677F (Inner backdrop) = hidden 56dp glass captured by tabsBackdrop,
//     tinted blue by ColorFilter.tint(accentColor), sampled by the indicator
//   - \u6807\u7B7E\u5185\u5BB9 (Tab content) = icon + label inside each tab slot
//
// Original: indicator.drawBackdrop(backdrop = rememberCombinedBackdrop(backdrop, tabsBackdrop))
//   - backdrop (outer) = LayerBackdrop = wallpaper (sampled via coverUv)
//   - tabsBackdrop (inner) = hidden Row's 56dp glass, inset 4dp from the
//     indicator's draw area on all sides.
//
// Implementation (mirrors sampleToggleBackdrop):
//   1. Sample wallpaper (outer backdrop) with blur \u2014 same as toggle's outer.
//   2. Composite the scene FBO (uBackdrop = container glass + content)
//      inside an INSET capsule SDF (containerRect shrunk 4dp each side).
//      This is the "smaller background plate" refracted inside the indicator.
vec4 sampleIndicatorBackdrop(vec2 canvasPx, float radius) {
    // 1. Sample wallpaper (outer LayerBackdrop) via coverUv (cover-fit).
    vec4 wp;
    if (radius < 0.5) {
        vec2 uv = coverUv(canvasPx);
        wp = texture2D(uWallpaperSampler, uv);
    } else {
        vec2 uv = coverUv(canvasPx);
        vec2 pxToUv = radius * canvasPxToUvScale();
        vec4 sum = vec4(0.0);
        float total = 0.0;
        sum += texture2D(uWallpaperSampler, uv) * 0.25; total += 0.25;
        sum += texture2D(uWallpaperSampler, uv + vec2( 1.000,  0.000) * pxToUv) * 0.12; total += 0.12;
        sum += texture2D(uWallpaperSampler, uv + vec2(-1.000,  0.000) * pxToUv) * 0.12; total += 0.12;
        sum += texture2D(uWallpaperSampler, uv + vec2( 0.000,  1.000) * pxToUv) * 0.12; total += 0.12;
        sum += texture2D(uWallpaperSampler, uv + vec2( 0.000, -1.000) * pxToUv) * 0.12; total += 0.12;
        sum += texture2D(uWallpaperSampler, uv + vec2( 0.707,  0.707) * pxToUv) * 0.0675; total += 0.0675;
        sum += texture2D(uWallpaperSampler, uv + vec2( 0.707, -0.707) * pxToUv) * 0.0675; total += 0.0675;
        sum += texture2D(uWallpaperSampler, uv + vec2(-0.707,  0.707) * pxToUv) * 0.0675; total += 0.0675;
        sum += texture2D(uWallpaperSampler, uv + vec2(-0.707, -0.707) * pxToUv) * 0.0675; total += 0.0675;
        wp = sum / total;
    }

    // 2. \u5185\u5C42\u80CC\u666F\u677F (Inner backdrop) SDF \u2014 the hidden Row's 56dp glass capsule.
    //    Faithful to LiquidBottomTabs.kt: the hidden Row has NO layerBlock,
    //    so its glass does NOT scale with the container. Only panelOffset
    //    shifts it (translationX = panelOffset).
    vec2 capsuleHalf = max(uContainerRect.zw, vec2(0.0));
    float cr = max(uContainerCornerRadius, 0.0);
    // Center = rectCenter + panelOffset (NO container scale).
    vec2 scaledCenter = uContainerRect.xy + vec2(uIndicatorPanelOffset, 0.0);
    vec2 capsuleLocal = canvasPx - scaledCenter;
    vec2 cq = abs(capsuleLocal) - capsuleHalf + vec2(cr);
    float capsuleSd = length(max(cq, vec2(0.0))) + min(max(cq.x, cq.y), 0.0) - cr;
    // Mask: interpolate between 1.0 (at rest) and smoothstep (when pressed).
    // At rest (progress=0): mask=1.0 \u2014 no separate smoothstep transition at
    // the containerRect boundary, because it overlaps with the indicator's own
    // edge (both 56dp capsules). A second smoothstep here would reveal raw
    // wallpaper at the indicator edge, causing jagged aliasing. With mask=1.0,
    // the indicator always shows the glass scene inside its shape, and edgeAlpha
    // smoothly fades to transparent \u2014 matching the container glass behind it.
    // When pressed (progress=1): restore the original smoothstep mask for the
    // CombinedBackdrop clipping. Refraction displaces samples away from the
    // shared edge, so the smoothstep no longer causes jaggies; and the inner
    // backdrop capsule clip preserves the correct CombinedBackdrop visual
    // (scene inside capsule, wallpaper outside).
    float indicatorAaRadius = max(radius, 1.0);
    float smoothstepMask = 1.0 - smoothstep(-indicatorAaRadius, indicatorAaRadius, capsuleSd);
    float mask = mix(1.0, smoothstepMask, uIndicatorPressProgress);

    // 2b. \u5185\u5C42\u80CC\u666F\u677F shadow (Shadow.Default) \u2014 faithful to LiquidBottomTabs.kt
    //     hidden Row's drawBackdrop: shadow defaults to Shadow.Default when not specified.
    //     Shadow.Default: radius=24dp, offset=DpOffset(0, radius/6=4dp), color=Black@0.1, alpha=1.
    //     In the CombinedBackdrop, the shadow is composited between wallpaper (outer)
    //     and glass body (inner). Through the semi-transparent glass body, this shadow
    //     bleeds through near the capsule edges \u2014 most visible near the top edge where
    //     the shadow offset (0, +4dp) makes those pixels "outside" the shadow capsule
    //     (shadow capsule top = original top + 4dp, so original top is outside it).
    //     Implementation mirrors ShadowModifier.kt:
    //       1. Shift capsule by shadow offset \u2192 shadow shape SDF
    //       2. Gaussian falloff (MaskFilter.makeBlur sigma = radius directly)
    //       3. Mask inside original capsule (ShadowMaskPaint BlendMode.Clear)
    //       4. Darken wallpaper by Black@0.1 \xD7 shadowIntensity
    float shadowOffsetYpx = (24.0 / 6.0) * uDpr; // DpOffset(0, radius/6) in device px
    vec2 shadowLocal = capsuleLocal - vec2(0.0, shadowOffsetYpx);
    vec2 shadowCq2 = abs(shadowLocal) - capsuleHalf + vec2(cr);
    float shadowSd = length(max(shadowCq2, vec2(0.0))) + min(max(shadowCq2.x, shadowCq2.y), 0.0) - cr;
    // Shadow intensity: Gaussian falloff from shadow shape edge.
    // MaskFilter.makeBlur(FilterBlurMode.NORMAL, radius) takes sigma = radius directly.
    float shadowSigma = max(24.0 * uDpr, 1.0); // sigma = 24dp in device px
    float shadowIntensity = 0.5 * exp(-shadowSd * shadowSd / (2.0 * shadowSigma * shadowSigma));
    // Mask shadow inside the original capsule (ShadowMaskPaint BlendMode.Clear
    // removes shadow where the shape itself is drawn, so shadow only appears outside).
    shadowIntensity *= smoothstep(-1.0, 1.0, capsuleSd);
    // Darken wallpaper by Black@0.1 \xD7 shadowIntensity (SrcOver compositing).
    wp.rgb *= (1.0 - shadowIntensity * 0.1);

    // 3. Sample the GLASS LAYER FBO (wallpaper + container glass, NO tab text).
    //    This is a snapshot taken after the container glass is rendered but
    //    before tab-content is drawn \u2014 so it has no white/black text to bleed
    //    through. The blue tab text is drawn on top via fgTexture (step 4).
    vec2 sceneUv2 = sceneUv(canvasPx - vec2(uIndicatorPanelOffset, 0.0));
    vec4 scene = texture2D(uTabsGlassLayer, sceneUv2);

    // 4. Draw blue \u6807\u7B7E\u5185\u5BB9 (tab content: icons/labels) on top of the glass layer.
    //    Use each tab's fgTexture alpha as a hard mask (step) \u2014 pixels inside
    //    the icon/label shape become blue, everything else stays the glass
    //    layer's natural color. No white edges (hard replace, no mix).
    //    Faithful to LiquidBottomTabs.kt: the hidden Row's tab content gets
    //    LocalLiquidBottomTabScale = lerp(1, 1.2, pressProgress) + panelOffset
    //    (NOT the container scale \u2014 the hidden Row is a sibling of the
    //    container, not a child, so the container layerBlock doesn't apply).
    float contentScale = 1.0 + 0.2 * uIndicatorPressProgress;
    float tabMask = 0.0;
    for (int i = 0; i < 8; i++) {
        if (float(i) >= uTabContentCount) break;
        vec4 r = uTabContentRects[i];
        if (r.z > 0.5 && r.w > 0.5) {
            // Tab content scales around its OWN center (not container center)
            // by contentScale, then shifts by panelOffset.
            vec2 tabCenter = r.xy + vec2(uIndicatorPanelOffset, 0.0);
            vec2 scaledHalf = r.zw * contentScale;
            vec2 localPx = canvasPx - (tabCenter - scaledHalf);
            vec2 uv = localPx / (scaledHalf * 2.0);
            if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)))) {
                float a = 0.0;
                if (i == 0) a = texture2D(uTabContentTex0, uv).a;
                else if (i == 1) a = texture2D(uTabContentTex1, uv).a;
                else if (i == 2) a = texture2D(uTabContentTex2, uv).a;
                else if (i == 3) a = texture2D(uTabContentTex3, uv).a;
                else if (i == 4) a = texture2D(uTabContentTex4, uv).a;
                else if (i == 5) a = texture2D(uTabContentTex5, uv).a;
                else if (i == 6) a = texture2D(uTabContentTex6, uv).a;
                else if (i == 7) a = texture2D(uTabContentTex7, uv).a;
                tabMask = max(tabMask, a);
            }
        }
    }
    // Use fgTexture alpha directly as the blue compositing factor. fgTexture
    // is LINEAR-filtered so its alpha has smooth AA edges \u2014 no smoothstep
    // threshold needed (which caused jaggies by hard-clipping the AA gradient).
    vec3 sceneColor = mix(scene.rgb, uIndicatorAccent.rgb, tabMask);

    // 5. Composite scene over wallpaper (SrcOver).
    //    At rest (mask\u22481.0): a \u2248 scene.a \u2014 glass scene composited at natural opacity.
    //    When pressed (mask=smoothstep): a = scene.a * mask \u2014 CombinedBackdrop clip.
    float a = scene.a * mask;
    vec3 resultRgb = mix(wp.rgb, sceneColor, a);

    // 6. \u5185\u5C42\u80CC\u666F\u677F rim highlight \u2014 faithful to LiquidBottomTabs.kt hidden Row:
    //    highlight = { Highlight.Default.copy(alpha = progress) }
    //    The HighlightModifier draws a STROKE (width=0.5dp, strokeWidth=2px)
    //    blurred by 0.25dp, clipped inside the capsule, colored by the
    //    DefaultHighlightShaderString AGSL shader:
    //      float2 grad = gradSdRoundedRect(centeredCoord, halfSize, gradRadius);
    //      float2 normal = float2(cos(angle), sin(angle));
    //      float d = dot(grad, normal);
    //      float intensity = pow(abs(d), falloff);
    //      return color * intensity;   // color = White(1.0), alpha=1*progress
    //    with angle=45\xB0, falloff=1, gradRadius = min(radius*1.5, min(halfW, halfH)).
    //    The stroke's outward half (capsuleSd > 0) is clipped, leaving the inner
    //    half. Final contribution = White(1.0) * intensity * strokeMask * progress,
    //    added with Plus blend (additive).
    //    NOTE: this is the SAME as the \u6307\u793A\u5668's own rim highlight (step 2f in
    //    post-passes) \u2014 both use Highlight.Default. The only difference is the
    //    SDF: here it's the \u5185\u5C42\u80CC\u666F\u677F capsule (inset 4dp), there it's the
    //    \u6307\u793A\u5668's own capsule. The shader math is identical.
    //
    //    The stroke mask is now sampled from a pre-rasterized Canvas2D texture
    //    (uInnerStrokeMask) instead of computed analytically (65-tap Gaussian
    //    convolution of a hard-edge stroke band). This gives browser-native Skia
    //    hardware coverage AA \u2014 identical quality to the outer indicator rim
    //    highlight. The Canvas2D pipeline does ctx.clip(path) \u2192 ctx.stroke(path)
    //    \u2192 ctx.filter=blur, which naturally removes the outer half and provides
    //    sub-pixel AA. No per-pixel SDF loops, no smoothstep clipAA needed.
    float highlightAlpha = uIndicatorPressProgress;
    if (highlightAlpha > 0.001) {
        // SDF gradient + Default highlight intensity (angle=45\xB0, falloff=1).
        // This part is identical to the AGSL DefaultHighlightShaderString.
        float indRadius = max(cr, 0.0);
        float indHalfMin = min(capsuleHalf.x, capsuleHalf.y);
        float gradRadius = min(indRadius * 1.5, indHalfMin);
        vec2 grad = gradSdRoundedRect(capsuleLocal, capsuleHalf, gradRadius);
        vec2 normal = vec2(0.70710678, 0.70710678); // cos(45\xB0), sin(45\xB0)
        float d = dot(grad, normal);
        float intensity = pow(abs(d), 1.0);

        // Sample the pre-rasterized Canvas2D stroke mask texture.
        // UV mapping: capsuleLocal (centered, -halfW..+halfW) \u2192 element-local
        // (0..2*halfW) by adding capsuleHalf \u2192 add margin offset \u2192 divide
        // by maskSize. This is the same convention as the outer indicator
        // stroke mask (STROKE_MASK_COMPOSITE_FRAGMENT_SHADER).
        vec2 innerLocal = capsuleLocal + capsuleHalf;
        vec2 innerMaskUv = (innerLocal + uInnerStrokeMaskOffset) / uInnerStrokeMaskSize;
        // Bounds check \u2014 discard samples outside the mask texture.
        float innerMask = 0.0;
        if (innerMaskUv.x >= 0.0 && innerMaskUv.x <= 1.0 &&
            innerMaskUv.y >= 0.0 && innerMaskUv.y <= 1.0) {
            innerMask = texture2D(uInnerStrokeMask, innerMaskUv).a;
        }

        // White(0.5) * intensity * innerMask * progress, Plus blend (additive).
        // Faithful to HighlightStyle.Default: color = White.copy(alpha=0.5f).
        // The AGSL shader uses this 0.5 alpha, NOT color.copy(alpha=1f).
        // Same fix as DEFAULT_HIGHLIGHT.alpha = 0.5 (was previously 1.0).
        // No clipAA needed \u2014 the Canvas2D clip(path) before stroke already removes
        // the outer half, and Skia hardware coverage provides AA.
        resultRgb += vec3(0.5) * intensity * innerMask * highlightAlpha;
    }

    return vec4(resultRgb, 1.0);
}

// Magnifier backdrop sampling \u2014 faithful to MagnifierContent.kt's
// onDrawBackdrop: withTransform({ scale(1.5); translate(top=-80dp) }, drawBackdrop).
// Zoom around the magnifier center, then offset Y toward cursor.
vec4 sampleMagnifier(vec2 canvasPx, float radius) {
    vec2 magCenter = uElementOffset + uElementSize * 0.5;
    vec2 zoomedCoord = magCenter + (canvasPx - magCenter) / uMagnifierZoom;
    vec2 cursorCoord = vec2(zoomedCoord.x, zoomedCoord.y + uMagnifierOffsetY);
    return sampleBackdrop(cursorCoord, radius);
}

// colorControls \u2014 exact port of ColorFilter.kt colorControlsColorFilter.
// saturation 1.5, brightness 0, contrast 1 -> pure saturation boost.
vec3 applyColorControls(vec3 c, float brightness, float contrast, float saturation) {
    float invSat = 1.0 - saturation;
    float r = 0.213 * invSat;
    float g = 0.715 * invSat;
    float b = 0.072 * invSat;
    float t = (0.5 - contrast * 0.5 + brightness) * 255.0;
    float cs = contrast * saturation;
    float cr = contrast * r;
    float cg = contrast * g;
    float cb = contrast * b;
    vec3 outc;
    outc.r = (cr + cs) * c.r + cg * c.g + cb * c.b + t / 255.0;
    outc.g = cr * c.r + (cg + cs) * c.g + cb * c.b + t / 255.0;
    outc.b = cr * c.r + cg * c.g + (cb + cs) * c.b + t / 255.0;
    return outc;
}

// --- HSV conversion + BlendMode.Hue ---------------------------
// Faithful port of Skia's BlendMode.Hue (non-separable blend).
// Hue blend: result takes hue from src, saturation+value from dst.
// Used by drawRect(tint, BlendMode.Hue) in onDrawSurface.
vec3 rgb2hsv(vec3 c) {
    float maxC = max(c.r, max(c.g, c.b));
    float minC = min(c.r, min(c.g, c.b));
    float delta = maxC - minC;
    float v = maxC;
    float s = maxC < 1e-6 ? 0.0 : delta / maxC;
    float h = 0.0;
    if (delta > 1e-6) {
        if (maxC == c.r) {
            h = mod((c.g - c.b) / delta, 6.0);
        } else if (maxC == c.g) {
            h = (c.b - c.r) / delta + 2.0;
        } else {
            h = (c.r - c.g) / delta + 4.0;
        }
        h *= 60.0;
        if (h < 0.0) h += 360.0;
    }
    return vec3(h / 360.0, s, v);
}

vec3 hsv2rgb(vec3 c) {
    float h = c.x * 6.0;
    float s = c.y;
    float v = c.z;
    float i = floor(h);
    float f = h - i;
    float p = v * (1.0 - s);
    float q = v * (1.0 - s * f);
    float t = v * (1.0 - s * (1.0 - f));
    i = mod(i, 6.0);
    if (i < 1.0) return vec3(v, t, p);
    if (i < 2.0) return vec3(q, v, p);
    if (i < 3.0) return vec3(p, v, t);
    if (i < 4.0) return vec3(p, q, v);
    if (i < 5.0) return vec3(t, p, v);
    return vec3(v, p, q);
}

// HSL \u2192 RGB. Input: h in [0,1] (hue/360), s in [0,1], l in [0,1].
// Unlike HSV (where V=1 gives the pure hue color), HSL with L=1 gives
// WHITE and L=0 gives BLACK \u2014 so the 'lightness' slider behaves like a
// proper brightness control: 1 = white, 0.5 = pure color, 0 = black.
// L=0.5 + S=1 is the pure hue; S=0 makes it a grayscale by L.
vec3 hsl2rgb(vec3 c) {
    float h = c.x;
    float s = c.y;
    float l = c.z;
    if (s < 0.001) return vec3(l);
    float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
    float p = 2.0 * l - q;
    float r = clamp(abs(mod(h * 6.0 + 0.0, 6.0) - 3.0) - 1.0, 0.0, 1.0);
    float g = clamp(abs(mod(h * 6.0 + 2.0, 6.0) - 3.0) - 1.0, 0.0, 1.0);
    float b = clamp(abs(mod(h * 6.0 + 4.0, 6.0) - 3.0) - 1.0, 0.0, 1.0);
    r = p + (q - p) * r;
    g = p + (q - p) * g;
    b = p + (q - p) * b;
    return vec3(r, g, b);
}

// BlendMode.Hue: take hue from src, sat+val from dst.
vec3 blendHue(vec3 dst, vec3 src) {
    vec3 dh = rgb2hsv(dst);
    vec3 sh = rgb2hsv(src);
    return hsv2rgb(vec3(sh.x, dh.y, dh.z));
}
`}function Zr(e=Ge){let r=Xt(e);return`
precision highp float;

${Wt}

${se}

${me}

${r}

void main() {
    // --- Coordinate reconstruction ---
    // Two paths: PEF (elFbo at BASELINE resolution) vs ping-pong (fullscreen).
    //
    // PEF path: elFbo is at baseline (origW*dpr + pad), NOT scaled by zoom.
    // gl_FragCoord ranges over [0, uElFboSize]. We compute:
    //   1. centeredOrigRot \u2014 un-rotated original-space coord (for SDF)
    //   2. screenCoord \u2014 rotated+scaled canvas position (for backdrop sampling)
    // The elFbo contains UN-ROTATED glass; rotation is applied at composite.
    // Backdrop sampling still needs the correct (rotated) screen position.
    //
    // Ping-pong path: fullscreen, rotation baked in shader (legacy).
    vec2 screenCoord;
    vec2 centeredOrigRot;  // un-rotated original-space coord for SDF
    vec2 elementCenter = uElementOffset + uElementSize * 0.5;
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    float rot = uElementRotation;

    if (uUsePerElementFbo > 0.5) {
        // elFbo fragment \u2192 centered local coord (Y-down, elFbo px)
        vec2 fboCenter = uElFboSize * 0.5;
        vec2 localUp = gl_FragCoord.xy - fboCenter;  // Y-up (gl_FragCoord BL origin)
        vec2 localDown = vec2(localUp.x, -localUp.y);  // Y-down (top-left origin)
        // Scale elFbo px \u2192 original px (accounts for AA pad: elFbo > origSize)
        vec2 origScale = uOriginalSize / uElFboSize;
        centeredOrigRot = localDown * origScale;  // un-rotated original space
        // Map to screen for backdrop sampling. When rot\u22480 (common case), skip
        // rotateBy entirely (4 mul + cos/sin per fragment saved). When rot\u22600,
        // apply rotation to map local-space coord to screen-space sample point.
        if (abs(rot) > 0.001) {
            screenCoord = elementCenter + rotateBy(centeredOrigRot, rot) * layerScale;
        } else {
            screenCoord = elementCenter + centeredOrigRot * layerScale;
        }
    } else {
        // Ping-pong: fullscreen, rotation in shader (legacy path)
        screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
        vec2 centeredScreen = screenCoord - elementCenter;
        vec2 centeredOrig = centeredScreen / layerScale;
        if (abs(rot) > 0.001) {
            centeredOrigRot = rotateBy(centeredOrig, -rot);
        } else {
            centeredOrigRot = centeredOrig;
        }
    }

    // Content scale (non-uniform): when < 1.0, compress the backdrop UV toward
    // the element center. Faithful to LiquidToggle.kt / LiquidSlider.kt.
    vec2 contentScale = vec2(uContentScaleX, uContentScaleY);
    vec2 sampleCoord = screenCoord;
    if (uContentScaleX < 0.999 || uContentScaleY < 0.999) {
        sampleCoord = elementCenter + (screenCoord - elementCenter) * contentScale;
    }

    vec2 origHalfSize = uOriginalSize * 0.5;
    float origRadius = uOriginalCornerRadius;

    // --- SDF-texture glass path (faithful to SdfShader.kt) ---
    if (uUseSdfTexture > 0.5) {
        vec2 localPx = centeredOrigRot + uOriginalSize * 0.5;
        vec4 sdfData = sampleSdfTexture(localPx);
        if (sdfData.y <= 0.0) discard;
        float intensity = sdfData.x;
        float sdfMask = sdfData.y;
        vec2 normal = sdfData.zw;

        // --- Raw SDF debug render -----------------------------------
        // Bypass all glass effects and output the SDF texture's R channel
        // directly as grayscale. Inside (sd<0) \u2192 white, edge (sd=0) \u2192 0.5,
        // outside (sd>0) \u2192 black. The A channel is preserved for AA. This
        // makes SDF quality / padding / aliasing directly visible \u2014 useful
        // when tuning DPR-adapted generation or highlight scale.
        if (uSdfDebugMode > 0.5) {
            vec2 uv = vec2(localPx.x / uOriginalSize.x,
                           localPx.y / uOriginalSize.y);
            vec4 v = texture2D(uSdfTexSampler, uv);
            // Decode R back to [-1,1]: negative = inside, positive = outside.
            float sd = v.r * 2.0 - 1.0;
            // Map sd \u2208 [-1, 1] \u2192 gray \u2208 [1, 0] (inside white, outside black).
            float gray = clamp(0.5 - sd * 0.5, 0.0, 1.0);
            // Overlay the normal as a faint RGB tint (so gradient direction is
            // visible). Multiplied by 0.15 so it doesn't swamp the gray.
            vec3 normalTint = vec3(v.g * 2.0 - 1.0, v.b * 2.0 - 1.0, 0.0) * 0.15;
            vec3 dbg = vec3(gray) + normalTint;
            // Use the same AA range as the non-debug path so the debug view
            // shows the real edge quality (not a hard threshold).
            float mask = smoothstep(uSdfAaMin, 1.0, v.a);
            float coverage = mask * uEnterAlpha;
            gl_FragColor = vec4(dbg * coverage, coverage);
            return;
        }

        // Compute the refracted sampling coordinate (SDF displacement).
        vec2 refractedOffsetOrig = intensity * uRefractionHeight * normal;
        vec2 refractedOffsetScreen = refractedOffsetOrig * layerScale;
        vec2 refractedScreen = screenCoord - refractedOffsetScreen;

        // Faithful to SdfShader.kt: color = content.eval(refractedCoord) * v.a
        // The content is the wallpaper after colorControls + blur(2dp).
        // FAITHFUL ORDERING: the original's onDrawBackdrop draws the wallpaper
        // AND drawRect(White 0.25) into the same buffer, THEN applies the
        // RenderEffect chain (colorControls, blur, SDF shader). So the white
        // overlay is PART of the SDF shader content input, and colorControls
        // is applied to the COMBINED (wallpaper + white) buffer.
        // We replicate: mix white into raw wallpaper FIRST, then apply
        // colorControls \u2014 so colorControls darkens the white too (matching
        // the original where contrast=0.75, brightness=-0.1 dims the white).
        //
        // TWO BACKDROP PATHS (adapted to global 2-pass blur):
        //   1. uSampleWallpaper > 0.5 (default / global-blur-OFF):
        //      Sample the WALLPAPER directly (uWallpaperSampler via coverUv)
        //      with inline poisson-disc blur (uBlurRadius). Faithful to the
        //      original's LayerBackdrop + blur(2dp).
        //   2. uSampleWallpaper < 0.5 (global-blur-ON, resolveBackdropTex has
        //      pre-blurred the cover-fitted wallpaper into uBackdrop):
        //      Sample uBackdrop via sceneUv with NO inline blur (it's already
        //      blurred by the 2-pass Gaussian pipeline). This adapts the SDF
        //      glass to the global separable blur setting, so the TextGlass
        //      respects blurDownsample / blurTapCap / dynamicBlurDownsample
        //      just like every other glass element. The cover-fitted wallpaper
        //      was rendered into wallpaperBlurFbo (canvas-sized) then 2-pass
        //      blurred, so sceneUv(refractedScreen) maps correctly.
        vec4 content;
        if (uSampleWallpaper > 0.5) {
            content = sampleWallpaperBlurred(refractedScreen, uBlurRadius);
        } else {
            content = sampleBackdrop(refractedScreen, 0.0);
        }
        vec3 rawContent = content.rgb;
        // Mix in white overlay (White 0.25 SrcOver) on RAW wallpaper first.
        if (uSurfaceColor.a > 0.001) {
            rawContent = uSurfaceColor.rgb * uSurfaceColor.a + rawContent * (1.0 - uSurfaceColor.a);
        }
        // THEN apply colorControls to the combined buffer.
        vec3 contentColor = applyColorControls(rawContent, uBrightness, uContrast, uSaturation);
        // Multiply by sdfMask (v.a) \u2014 faithful to content * v.a.
        vec3 color = contentColor * sdfMask;

        // Edge matte helpers \u2014 computed PER LAYER so each can be tuned
        // independently via uSdfEdgeMatte{Bevel,Tint,Base}Params. The base
        // edge factor is intensity (1 at the text boundary, \u21920 interior).
        // Per-layer params (vec2 = range, min) shape that into the final
        // matte weight:
        //   edge = clamp(intensity / max(range, 0.001), 0, 1) * (1 - min) + min
        //   range (0..1): how far the matte extends inward. 1 = full fade
        //     across the whole intensity field (original behavior); 0.5 =
        //     full strength by intensity=0.5 then flat (narrower rim); small
        //     = very thin matte line.
        //   min (0..1): floor matte amount in the deep interior. 0 = interior
        //     clear; 0.3 = interior always \u226530% matte.
        // bit 0 = bevel (\u5149\u5F71), bit 1 = tint (\u67D3\u8272), bit 2 = base (\u6298\u5C04/\u5E95\u8272).
        // When the overall uSdfEdgeMatteEnabled is OFF, no matte is applied
        // regardless of the bitmask. Faithful to "\u54D1\u5149\u5C42\u53EF\u4EE5\u8C03\u662F\u5426\u4F5C\u7528\u4E8E\u67D0\u4E9B\u5C42"
        // + "\u7ED9\u54D1\u5149\u6BCF\u5C42\u52A0\u4E0A\u4F5C\u7528\u53C2\u6570\u8C03\u8282\uFF0C\u6BD4\u5982\u8303\u56F4\uFF0C\u6700\u5C0F\u503C".
        float matteStrength = 0.65;   // desaturate toward luminance
        float matteDarken = 0.18;     // darken
        bool matteOn = uSdfEdgeMatteEnabled > 0.5;
        // bit 0 (bevel/\u63D0\u4EAE): targets mod 2. The previous code used
        // (targets - 8.0 * floor(targets / 8.0)) which is targets mod 8 \u2014
        // that returns a non-zero value for ANY non-zero targets (1..7), so
        // the bevel matte was ALWAYS on whenever matteOn was true, regardless
        // of whether bit 0 was actually set. This made the bevel matte toggle
        // ineffective \u2014 turning off bit 0 (bevel) still left the bevel matte
        // active. Fixed to use targets mod 2 which correctly extracts ONLY
        // bit 0.
        float t1 = floor(uSdfEdgeMatteTargets / 1.0);  // = targets
        bool matteBevel = matteOn && (t1 - 2.0 * floor(t1 / 2.0)) >= 1.0;
        // bit 1 (tint): floor(targets/2) mod 2
        float t2 = floor(uSdfEdgeMatteTargets / 2.0);
        bool matteTint = matteOn && (t2 - 2.0 * floor(t2 / 2.0)) >= 1.0;
        // bit 2 (base): floor(targets/4) mod 2
        float t4 = floor(uSdfEdgeMatteTargets / 4.0);
        bool matteBase = matteOn && (t4 - 2.0 * floor(t4 / 2.0)) >= 1.0;
        // bit 3 (brighten/\u63D0\u4EAE): floor(targets/8) mod 2. The brighten layer
        // is the overall brightness increment (uBrightness from the \u63D0\u4EAE
        // slider). When matteBrighten is true, the edge is pulled back toward
        // the pre-brightness rawContent \u2014 i.e. the edge gets LESS brightening
        // than the interior, producing a matte rim on the brightness layer.
        float t8 = floor(uSdfEdgeMatteTargets / 8.0);
        bool matteBrighten = matteOn && (t8 - 2.0 * floor(t8 / 2.0)) >= 1.0;
        // Per-layer matte edge factor \u2014 shaped by (range, min) params.
        float matteEdgeBase = clamp(intensity / max(uSdfEdgeMatteBaseParams.x, 0.001), 0.0, 1.0)
            * (1.0 - uSdfEdgeMatteBaseParams.y) + uSdfEdgeMatteBaseParams.y;
        // Brighten layer edge factor \u2014 shaped by the BRIGHTEN layer's params.
        float matteEdgeBrighten = clamp(intensity / max(uSdfEdgeMatteBrightenParams.x, 0.001), 0.0, 1.0)
            * (1.0 - uSdfEdgeMatteBrightenParams.y) + uSdfEdgeMatteBrightenParams.y;
        // Bevel / tint edge factors computed where they're used (below).

        // --- Brighten layer matte (bit 3) ---
        // \u63D0\u4EAE\u54D1\u5149: the brighten (uBrightness) amount is ATTENUATED at the
        // edge by edgeFactor \xD7 strength. So the edge gets LESS brightening
        // than the interior \u2014 a PURE brightness cut at the rim, NOT
        // desaturation. We re-apply colorControls with an attenuated
        // brightness (full interior \u2192 0 at edge when s=1); contrast +
        // saturation stay fully applied everywhere (NO saturation cut).
        // Faithful to "\u4E3A\u4EC0\u4E48\u4F1A\u540C\u65F6\u524A\u51CF\u9971\u548C\u5EA6\u5C42" \u2014 fixed: only brightness is
        // cut, saturation + contrast untouched.
        if (matteBrighten) {
            float s = uSdfEdgeMatteBrightenStrength;
            float attBrightness = uBrightness * (1.0 - matteEdgeBrighten * s);
            vec3 attenuated = applyColorControls(rawContent, attBrightness, uContrast, uSaturation);
            color.rgb = attenuated * sdfMask;
        }

        // --- Base layer matte (bit 2) ---
        // Desaturate + darken the base refraction/body color at the edge.
        // Strength scales both the desaturate and darken amounts.
        if (matteBase) {
            float s = uSdfEdgeMatteBaseStrength;
            float lum = dot(color.rgb, vec3(0.213, 0.715, 0.072));
            color.rgb = mix(color.rgb, vec3(lum), matteEdgeBase * matteStrength * s);
            color.rgb *= 1.0 - matteEdgeBase * matteDarken * s;
        }

        // Bevel lighting \u2014 gated by uSdfBevelEnabled so the TextGlass "\u5149\u5F71"
        // toggle can turn the light/shadow layer off WITHOUT zeroing
        // uSdfHighlightScale (which would also kill the refraction, since
        // intensity drives both). When bevel is off, the glass still refracts
        // the backdrop using the thickness slider's value \u2014 only the edge
        // brightness highlight is removed. The base dim is handled separately
        // via uBrightness on the JS side.
        // The bevel highlight is always pure white (no dye) \u2014 the whole-glass
        // tint (uSdfGlassTintHue) is applied separately below and affects the
        // ENTIRE glass body, not just the bevel band.
        // Edge matte (bit 0): when matteBevel is true, TWO visible effects
        // happen at the bevel band's edge, BOTH scaled by bevelMatteS (the
        // per-layer strength slider) so the user can actually SEE the matte
        //\u8C03\u8282:
        //   1. Weaken the bevel brightening (less shiny highlight at edge).
        //   2. APPLY a desaturate + darken to the color at the edge \u2014 this
        //      produces the visible frosted/matte rim. Without this, a small
        //      bevel value (e.g. 0.32) makes the weakening nearly invisible,
        //      so the strength slider appeared to "do nothing". Now both
        //      effects are driven by the same strength so the slider is
        //      always visually responsive.
        // The edge factor is shaped by the BEVEL layer's (range, min) params.
        float matteEdgeBevel = clamp(intensity / max(uSdfEdgeMatteBevelParams.x, 0.001), 0.0, 1.0)
            * (1.0 - uSdfEdgeMatteBevelParams.y) + uSdfEdgeMatteBevelParams.y;
        // Bevel matte strength \u2014 scales BOTH the weakening and the matte rim.
        float bevelMatteS = uSdfEdgeMatteBevelStrength;
        if (uSdfBevelEnabled > 0.5) {
            float angleRad = uSdfLightAngle * 3.1415926 / 180.0;
            vec2 lightDir = vec2(cos(angleRad), sin(angleRad));
            float bevel1 = clamp(dot(normal, lightDir), 0.0, 1.0);
            float bevel1Amt = 0.5 * intensity * bevel1;
            if (matteBevel) {
                // (1) Weaken the bevel brightening at the edge.
                bevel1Amt *= 1.0 - matteEdgeBevel * (matteStrength + matteDarken) * bevelMatteS;
            }
            color.rgb *= 1.0 + bevel1Amt;
            float bevel2 = clamp(dot(normal, -lightDir), 0.0, 1.0);
            float bevel2Amt = 0.5 * bevel2 * min(1.0, smoothstep(1.0, 0.0, abs(intensity - 0.25) * 6.0));
            if (matteBevel) {
                bevel2Amt *= 1.0 - matteEdgeBevel * (matteStrength + matteDarken) * bevelMatteS;
            }
            color.rgb *= 1.0 + bevel2Amt;
            // (2) APPLY the matte rim: desaturate toward luminance + darken at
            // the edge. This is the VISIBLE matte effect on the bevel layer \u2014
            // without it the strength slider had no visible feedback when the
            // bevel value was small. Faithful to "\u6211\u8981\u80FD\u8C03\u63D0\u4EAE\u5C42\u7684\u54D1\u5149".
            if (matteBevel) {
                float lum = dot(color.rgb, vec3(0.213, 0.715, 0.072));
                color.rgb = mix(color.rgb, vec3(lum), matteEdgeBevel * matteStrength * bevelMatteS);
                color.rgb *= 1.0 - matteEdgeBevel * matteDarken * bevelMatteS;
            }
        }

        // Whole-glass tint (\u67D3\u8272) \u2014 gated by uSdfGlassTintEnabled master switch.
        // Two stages, both using the same hue:
        //   1. Color-mix filter (\u67D3\u8272\u524D\u6EE4\u955C): mixes the glass body toward the
        //      pure saturated hue color by uSdfGlassTintMix amount (SrcOver-
        //      style blend toward a solid color). This is a "color mix" filter
        //      \u2014 distinct from the hue-dye. 0 = skip; 1 = full color overlay.
        //   2. Hue-dye: applies BlendMode.Hue (Skia non-separable Hue blend) at
        //      uSdfGlassTintStrength (default 0.85, adjustable) \u2014 takes hue from
        //      the tint source, keeps the glass's own saturation + value. So a
        //      dyed glass still looks like glass (luminance/sat preserved) just
        //      tinted. The strength slider lets the user tune how strong the
        //      dye is (0 = no dye, 1 = full hue replacement).
        // Both stages apply to the ENTIRE glass body (not just the bevel band).
        // Independent of the \u5149\u5F71 (bevel) toggle.
        // Edge matte (bit 1): when matteTint is true, the tint's blend factor
        // is reduced at the edge \u2014 the rim keeps more of the desaturated base
        // color instead of the dyed hue, so the edge looks matte while the
        // interior stays fully dyed. The edge factor is shaped by the TINT
        // layer's (range, min) params.
        float matteEdgeTint = clamp(intensity / max(uSdfEdgeMatteTintParams.x, 0.001), 0.0, 1.0)
            * (1.0 - uSdfEdgeMatteTintParams.y) + uSdfEdgeMatteTintParams.y;
        // Tint matte strength \u2014 scales how much the tint is suppressed at edge.
        float tintMatteS = uSdfEdgeMatteTintStrength;
        if (uSdfGlassTintEnabled > 0.5) {
            vec3 tintSrc = hsl2rgb(vec3(uSdfGlassTintHue / 360.0, uSdfGlassTintSaturation, uSdfGlassTintLightness));
            // Stage 1: color-mix filter (before hue-dye).
            if (uSdfGlassTintMix > 0.001) {
                float mixAmt = uSdfGlassTintMix;
                if (matteTint) {
                    mixAmt *= 1.0 - matteEdgeTint * matteStrength * tintMatteS;
                }
                color.rgb = mix(color.rgb, tintSrc, mixAmt);
            }
            // Stage 2: hue-dye (BlendMode.Hue at uSdfGlassTintStrength).
            // The dye strength is now adjustable (default 0.85, matching the
            // original's hardcoded constant). 0 = no hue-dye; 1 = full hue
            // replacement. Faithful to "\u52A0\u4E00\u4E2A\u8C03\u67D3\u8272\u5F3A\u5EA6\u7684".
            vec3 hueBlended = blendHue(color, tintSrc);
            float tintMix = uSdfGlassTintStrength;
            if (matteTint) {
                tintMix *= 1.0 - matteEdgeTint * matteStrength * tintMatteS;
            }
            color.rgb = mix(color.rgb, hueBlended, tintMix);
        }

        // NOTE: the old unconditional edge-matte block (which applied a single
        // global desaturate+darken to the composited color) has been replaced
        // by the per-layer matte applications above (base / bevel / tint),
        // each gated by its bit in uSdfEdgeMatteTargets.

        // PREMULTIPLIED output: RGB = color * coverage, A = coverage.
        // 'color' already includes '* sdfMask' (line above), so we only need
        // to also factor in uEnterAlpha to keep RGB and A consistent.
        // Premultiplied storage is REQUIRED for the elFbo: its texture uses
        // LINEAR filtering, and bilinear interpolation of non-premultiplied
        // alpha darkens RGB at the coverage boundary (the classic
        // "non-premult + bilinear" artifact that produces a dark fringe).
        // The composite pass then uses premult SrcOver (ONE, ONE_MINUS_SRC_ALPHA).
        float sdfCoverage = sdfMask * uEnterAlpha;
        gl_FragColor = vec4(color * uEnterAlpha, sdfCoverage);
        return;
    }

    // SDF for refraction/highlight \u2014 sdShape() dispatches to the G2 SDF
    // texture (sampleClipSdf) when uUseContinuousSdf=1 AND
    // uNoContinuousSdfInRefraction=0, else the analytic sdRoundedRect.
    float sd = sdShape(centeredOrigRot, origHalfSize, origRadius);
    // Clip + edgeAA: alpha mask (browser-native AA) when capsule enabled.
    float edgeAlpha;
    if (uUseContinuousSdf > 0.5) {
        float mask = sampleClipMask(centeredOrigRot, origHalfSize, origRadius);
        if (mask < 0.01) discard;
        edgeAlpha = mask;
    } else {
        if (sd > 0.5) discard;
        edgeAlpha = 1.0 - smoothstep(-0.5, 0.5, sd);
    }

    // --- 1. Backdrop sample (before refraction) -------------------
    // Use sampleCoord (content-scaled) so the backdrop shrinks inward when
    // uContentScaleX/Y < 1.0 (toggle/slider knob press effect).
    vec4 backdrop;
    if (uIndicatorBackdrop > 0.5) {
        backdrop = sampleIndicatorBackdrop(screenCoord, uBlurRadius);
    } else if (uUseToggleBackdrop > 0.5) {
        backdrop = sampleToggleBackdrop(screenCoord, uBlurRadius);
    } else if (uUseMagnifier > 0.5) {
        backdrop = sampleMagnifier(screenCoord, uBlurRadius);
    } else {
        backdrop = sampleBackdrop(sampleCoord, uBlurRadius);
    }
    // colorControls: for backdropFbo+useSeparableBlur elements, cc was already
    // applied as a fullscreen pass BEFORE the 2-pass blur (uSkipColorControls=1),
    // matching the original's colorControls\u2192blur order. Skip here to avoid
    // double-applying. For inline-blur elements, apply here.
    vec3 color = (uSkipColorControls > 0.5) ? backdrop.rgb : applyColorControls(backdrop.rgb, uBrightness, uContrast, uSaturation);
    // Magnifier glass is always OPAQUE \u2014 faithful to the original which
    // samples rememberCombinedBackdrop (wallpaper + content + cursor all
    // composited onto the opaque wallpaper). The port's scene texture may
    // carry partial alpha (e.g. card 0.9), which would make the glass
    // translucent. Force alpha=1 for magnifier.
    float alpha = (uUseMagnifier > 0.5) ? 1.0 : backdrop.a;

    // --- 2. Lens refraction (SDF + circleMap) ---------------------
    // Faithful port of RoundedRectRefractionWithDispersionShaderString.
    // SDF/grad computed in ORIGINAL space; uRefractionHeight/Amount are in
    // original px (NOT scaled by layerScale \u2014 the original AGSL shader receives
    // the original size and the graphicsLayer scales the OUTPUT, not the params).
    // Early-out: if we're deeper than refractionHeight from the edge,
    // skip refraction entirely (the lens doesn't reach here).
    if (uRefractionHeight > 0.5 && (-sd) < uRefractionHeight) {
        float sdClamped = min(sd, 0.0);
        float d = circleMap(1.0 - (-sdClamped) / uRefractionHeight) * uRefractionAmount;

        float gradRadius = min(origRadius * 1.5, min(origHalfSize.x, origHalfSize.y));
        vec2 grad = gradSdRoundedRect(centeredOrigRot, origHalfSize, gradRadius);
        // AGSL: normalize(grad + depthEffect * normalize(centeredCoord))
        vec2 depthVec = vec2(0.0);
        if (uDepthEffect > 0.5) {
            float dirLen = length(centeredOrigRot);
            if (dirLen > 1e-6) depthVec = centeredOrigRot / dirLen;
        }
        vec2 gradSum = grad + uDepthEffect * depthVec;
        float gradLen = length(gradSum);
        if (gradLen > 1e-6) grad = gradSum / gradLen;

        // Refraction offset in ORIGINAL space, then map to SCREEN space.
        //   offset_orig = d * grad          (original px)
        //   offset_screen = offset_orig * layerScale  (screen px, for sampling)
        // Faithful to: AGSL computes offset in original space, then graphicsLayer
        // scales the rendered output \u2014 so a pixel at original position p samples
        // the backdrop at p + offset_orig, and the result appears at screen
        // position center + p*layerScale. The backdrop sample position in screen
        // space is therefore center + (p + offset_orig)*layerScale
        // = screenCoord + offset_orig * layerScale.
        vec2 refractedOffsetOrig = d * grad;
        // Rotate the local-space offset BACK to screen space (by +rotation),
        // then scale by layerScale. Without the rotation, refraction points
        // in the wrong direction when the element is rotated.
        vec2 refractedOffsetScreen = rotateBy(refractedOffsetOrig, rot) * layerScale;
        vec2 refractedScreen = screenCoord + refractedOffsetScreen;
        vec2 refractedSampleCoord = refractedScreen;
        if (uIndicatorBackdrop < 0.5 && uUseToggleBackdrop < 0.5 &&
            (uContentScaleX < 0.999 || uContentScaleY < 0.999)) {
            refractedSampleCoord = elementCenter + (refractedScreen - elementCenter) * contentScale;
        }

        if (uChromaticAberration > 0.5) {
            // Faithful 7-path chromatic dispersion (ROYGBV + purple).
            // Original AGSL: dispersionIntensity = chromaticAberration * (cx*cy)/(hx*hy)
            //                dispersedCoord = d * grad * dispersionIntensity
            // 7 samples at dispersedCoord * {1, 2/3, 1/3, 0, -1/3, -2/3, -1}
            // with weighted channel accumulation.
            float dispersionIntensity = 1.0 * ((centeredOrigRot.x * centeredOrigRot.y) / (origHalfSize.x * origHalfSize.y));
            vec2 dispersedOffsetOrig = refractedOffsetOrig * dispersionIntensity;
            vec2 dispersedOffsetScreen = rotateBy(dispersedOffsetOrig, rot) * layerScale;

            // Sample helper \u2014 pick the right backdrop sampler.
            #define SAMPLE_DISPERSED(offset)                 (uIndicatorBackdrop > 0.5 ? sampleIndicatorBackdrop(refractedScreen + (offset), uBlurRadius) :                  uUseToggleBackdrop > 0.5 ? sampleToggleBackdrop(refractedScreen + (offset), uBlurRadius) :                  uUseMagnifier > 0.5 ? sampleMagnifier(refractedScreen + (offset), uBlurRadius) :                  sampleBackdrop(refractedSampleCoord + (offset), uBlurRadius))

            vec4 sRed    = SAMPLE_DISPERSED(+dispersedOffsetScreen);
            vec4 sOrange = SAMPLE_DISPERSED(+dispersedOffsetScreen * (2.0 / 3.0));
            vec4 sYellow = SAMPLE_DISPERSED(+dispersedOffsetScreen * (1.0 / 3.0));
            vec4 sGreen  = SAMPLE_DISPERSED(vec2(0.0));
            vec4 sCyan   = SAMPLE_DISPERSED(-dispersedOffsetScreen * (1.0 / 3.0));
            vec4 sBlue   = SAMPLE_DISPERSED(-dispersedOffsetScreen * (2.0 / 3.0));
            vec4 sPurple = SAMPLE_DISPERSED(-dispersedOffsetScreen);

            #undef SAMPLE_DISPERSED

            // Faithful channel weighting from the original AGSL shader.
            vec3 dispColor = vec3(0.0);
            float dispAlpha = 0.0;
            // red
            dispColor.r += sRed.r / 3.5;
            dispAlpha  += sRed.a / 7.0;
            // orange
            dispColor.r += sOrange.r / 3.5;
            dispColor.g += sOrange.g / 7.0;
            dispAlpha  += sOrange.a / 7.0;
            // yellow
            dispColor.r += sYellow.r / 3.5;
            dispColor.g += sYellow.g / 3.5;
            dispAlpha  += sYellow.a / 7.0;
            // green
            dispColor.g += sGreen.g / 3.5;
            dispAlpha  += sGreen.a / 7.0;
            // cyan
            dispColor.g += sCyan.g / 3.5;
            dispColor.b += sCyan.b / 3.0;
            dispAlpha  += sCyan.a / 7.0;
            // blue
            dispColor.b += sBlue.b / 3.0;
            dispAlpha  += sBlue.a / 7.0;
            // purple
            dispColor.r += sPurple.r / 7.0;
            dispColor.b += sPurple.b / 3.0;
            dispAlpha  += sPurple.a / 7.0;

            color = (uSkipColorControls > 0.5) ? dispColor : applyColorControls(dispColor, uBrightness, uContrast, uSaturation);
            // Magnifier chromatic aberration also forces opaque.
            alpha = (uUseMagnifier > 0.5) ? 1.0 : dispAlpha;
        } else {
            vec4 refracted;
            if (uIndicatorBackdrop > 0.5) {
                refracted = sampleIndicatorBackdrop(refractedScreen, uBlurRadius);
            } else if (uUseToggleBackdrop > 0.5) {
                refracted = sampleToggleBackdrop(refractedScreen, uBlurRadius);
            } else if (uUseMagnifier > 0.5) {
                refracted = sampleMagnifier(refractedScreen, uBlurRadius);
            } else {
                refracted = sampleBackdrop(refractedSampleCoord, uBlurRadius);
            }
            color = (uSkipColorControls > 0.5) ? refracted.rgb : applyColorControls(refracted.rgb, uBrightness, uContrast, uSaturation);
            // Magnifier refraction also forces opaque (see backdrop sample above).
            alpha = (uUseMagnifier > 0.5) ? 1.0 : refracted.a;
        }
    }

    // --- 3. onDrawSurface: tint (BlendMode.Hue + 0.75 alpha) -----
    // Faithful port of LiquidButton.kt onDrawSurface:
    //   drawRect(tint, blendMode = BlendMode.Hue)
    //   drawRect(tint.copy(alpha = 0.75f))
    // First pass: replace backdrop hue with tint hue (Hue blend, alpha = tint.a).
    // Second pass: overlay tint color at 0.75*alpha (SrcOver blend).
    if (uTintColor.a > 0.001) {
        vec3 hueBlended = blendHue(color, uTintColor.rgb);
        color = mix(color, hueBlended, uTintColor.a);
        color = mix(color, uTintColor.rgb, 0.75 * uTintColor.a);
    }

    // --- 4. onDrawSurface: surfaceColor (drawRect(surfaceColor)) --
    if (uSurfaceColor.a > 0.001) {
        color = mix(color, uSurfaceColor.rgb, uSurfaceColor.a);
    }

    // --- 5. Highlight (edge specular) -----------------------------
    // NOTE: The rim highlight is drawn as a SEPARATE pass (see
    // RIM_HIGHLIGHT_FRAGMENT_SHADER) with true Plus/SrcOver blend,
    // matching the original HighlightModifier.kt which records a separate
    // graphics layer. Doing it inline here would dim the highlight via the
    // element's edge AA, which is wrong \u2014 the highlight layer is composited
    // on top with its own blend mode.

    // --- 7. Edge anti-aliasing -----------------------------------
    // edgeAlpha was computed earlier (mask mode: direct coverage, analytic: smoothstep).
    //
    // PREMULTIPLIED output: RGB = color * coverage, A = coverage.
    // The elFbo texture uses LINEAR filtering; storing non-premultiplied
    // (color, coverage) causes bilinear interpolation between an edge texel
    // (color, 0.5) and the cleared-outside texel (0,0,0,0) to produce
    // ((1-t)*color, (1-t)*0.5) \u2014 RGB darkened by (1-t). The composite's
    // SrcOver blend then multiplies RGB by alpha AGAIN, squaring the
    // darkening \u2192 dark fringe at the glass edge.
    // Premultiplying here makes the linear filter mathematically correct:
    // lerp((color*a, a), (0,0,0,0), t) = ((1-t)*color*a, (1-t)*a), which
    // composites correctly with premult SrcOver (ONE, ONE_MINUS_SRC_ALPHA).
    float coverage = alpha * edgeAlpha * uEnterAlpha;
    gl_FragColor = vec4(color * coverage, coverage);
}
`}var qe=Zr(Ge);var Ye=`
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uElementOffset;   // SCALED rect top-left (where the quad is drawn)
uniform vec2  uElementSize;     // SCALED size (includes graphicsLayer scale)
uniform vec4  uCornerRadii;     // SCALED corner radii
uniform float uShadowRadius;    // ORIGINAL px (NOT scaled \u2014 faithful to BlurMaskFilter at original size)
uniform vec2  uShadowOffset;    // ORIGINAL px (offsetX, offsetY; +Y = downward)
uniform vec4  uShadowColor;     // rgba
// --- ORIGINAL-SPACE SDF (faithful to graphicsLayer { scaleX, scaleY }) ---
// Same approach as the element shader: compute the shadow SDF in ORIGINAL
// space (shape is a correct capsule, not stretched), then the graphicsLayer
// scales the entire shadow layer by (scaleX, scaleY). The shadow offset is
// in ORIGINAL px; we multiply by uLayerScale to map it to screen space for
// the SDF evaluation (offset_screen = offset_orig * layerScale). The shadow
// radius (blur sigma) stays in ORIGINAL px because the Gaussian falloff is
// computed in original space \u2014 the graphicsLayer then stretches the blurred
// result, which is the faithful behavior (BlurMaskFilter blurs at original
// resolution, then graphicsLayer scales the blurred pixels).
uniform vec2  uOriginalSize;        // element size in px (ORIGINAL, unscaled)
uniform float uOriginalCornerRadius; // corner radius in px (ORIGINAL, unscaled)
uniform vec2  uLayerScale;          // (scaleX, scaleY) from graphicsLayer
uniform float uElementRotation;     // rotation in radians (graphicsLayer rotationZ)

${se}

void main() {
    // Flip gl_FragCoord (bottom-left origin) to top-left origin, so +Y
    // points downward \u2014 matching CSS convention.
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    // elementCenter is the SAME for scaled and original rects (scaling is
    // around the center), so uElementOffset + uElementSize*0.5 gives the
    // correct center.
    vec2 elementCenter = uElementOffset + uElementSize * 0.5;
    vec2 centeredScreen = screenCoord - elementCenter;
    // Map to ORIGINAL space (guard against divide-by-zero).
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    vec2 centeredOrig = centeredScreen / layerScale;
    // Un-rotate into local space so the shadow shape rotates with the element.
    // Also rotate the shadow offset into local space so it stays consistent.
    vec2 centeredOrigRot = rotateBy(centeredOrig, -uElementRotation);
    vec2 shadowOffsetRot = rotateBy(uShadowOffset, -uElementRotation);

    vec2 origHalfSize = uOriginalSize * 0.5;
    float origRadius = uOriginalCornerRadius;

    // Shadow offset: defined in ORIGINAL px, applied in screen space.
    // The original draws the shadow at original size with this offset, then
    // graphicsLayer scales the whole layer \u2014 so the offset effectively
    // becomes offset_orig * layerScale in screen space. We map it back to
    // original space for the SDF: offset_orig = offset_screen / layerScale,
    // which cancels \u2014 so we use uShadowOffset directly in original space.
    vec2 shadowCenteredOrig = centeredOrigRot - shadowOffsetRot;
    float sd = sdShape(shadowCenteredOrig, origHalfSize, origRadius);
    // SDF of the element itself (not offset) \u2014 used to mask the shadow
    // inside the element so it doesn't bleed through the AA edge.
    float elementSd = sdShape(centeredOrigRot, origHalfSize, origRadius);

    // Shadow intensity: Gaussian falloff from the shadow shape's edge.
    // uShadowRadius is in ORIGINAL px (faithful to BlurMaskFilter at original
    // size). sigma = radius/3 matches the BlurMaskFilter spread.
    float sigma = max(uShadowRadius / 3.0, 1.0);
    float shadow = 0.5 * exp(-sd * sd / (2.0 * sigma * sigma));
    // Mask out the shadow inside the element (the element covers it).
    shadow *= smoothstep(-1.0, 1.0, elementSd);

    gl_FragColor = vec4(uShadowColor.rgb, uShadowColor.a * shadow);
}
`,Qr=`
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uElementOffset;
uniform vec2  uElementSize;
uniform vec4  uCornerRadii;
uniform float uInnerShadowRadius;
uniform float uInnerShadowAlpha;
uniform vec2  uInnerShadowOffset;

${se}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    vec2 localCoord = screenCoord - uElementOffset;
    vec2 halfSize = uElementSize * 0.5;
    vec2 centeredCoord = localCoord - halfSize;

    float radius = radiusAt(centeredCoord, uCornerRadii);
    float sd = sdShape(centeredCoord, halfSize, radius);
    if (sd > 0.5) discard;

    vec2 innerCentered = centeredCoord - uInnerShadowOffset;
    float innerSd = sdShape(innerCentered, halfSize, radius);
    float band = smoothstep(uInnerShadowRadius, 0.0, innerSd);
    band *= step(0.0, innerSd);
    gl_FragColor = vec4(0.0, 0.0, 0.0, band * uInnerShadowAlpha * 0.5);
}
`;var Ve=`
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uOffset;       // element top-left in canvas px (top-left origin) \u2014 SCALED rect
uniform vec2  uSize;         // element size in canvas px \u2014 SCALED
uniform vec4  uCornerRadii;  // capsule radii (topLeft, topRight, bottomRight, bottomLeft) in px \u2014 SCALED
uniform vec4  uColor;        // rgba; usually white * (alpha = 0.15 * progress)
uniform float uRadius;       // glow radius in canvas px (= minDim * 1.5, SCALED space)
uniform vec2  uPosition;     // finger position in element-local px (top-left origin, SCALED space)
// --- ORIGINAL-SPACE SDF clip (faithful to graphicsLayer { scaleX, scaleY }) ---
// The press glow (InteractiveHighlight) is drawn INSIDE the graphicsLayer, so
// it is clipped to the ORIGINAL capsule shape, then scaled with the layer.
// The glow position + radius are in SCALED space (they track the finger in
// screen px), but the clip SDF is in original space so the capsule clip stays
// correct when the button is stretched.
uniform vec2  uOriginalSize;
uniform float uOriginalCornerRadius;
uniform vec2  uLayerScale;
uniform float uElementRotation;

${se}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    vec2 localCoord = screenCoord - uOffset;

    // --- Capsule clip in ORIGINAL space (faithful to graphicsLayer clip) ---
    vec2 elementCenter = uOffset + uSize * 0.5;
    vec2 centeredScreen = screenCoord - elementCenter;
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    vec2 centeredOrig = centeredScreen / layerScale;
    vec2 origHalfSize = uOriginalSize * 0.5;
    float sd = sdShape(rotateBy(centeredOrig, -uElementRotation), origHalfSize, uOriginalCornerRadius);
    if (sd > 0.5) discard;
    float clipAlpha = 1.0 - smoothstep(-0.5, 0.5, sd);

    // Faithful AGSL port: smoothstep(radius, radius*0.5, dist) means
    // intensity = 1 at dist <= radius*0.5, fading to 0 at dist >= radius.
    // dist + uPosition are in SCALED local space (finger tracks screen px).
    float dist = distance(localCoord, uPosition);
    float intensity = smoothstep(uRadius, uRadius * 0.5, dist);

    // Premultiplied Plus-blend contribution. Renderer uses blendFunc(ONE, ONE)
    // so result.rgb = contribution + dst.rgb (clamped to 1).
    vec3 contribution = uColor.rgb * uColor.a * intensity * clipAlpha;
    gl_FragColor = vec4(contribution, 1.0);
}
`,Ke=`
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uOffset;
uniform vec2  uSize;
uniform vec4  uCornerRadii;
uniform vec4  uColor;
// --- ORIGINAL-SPACE SDF clip (faithful to graphicsLayer { scaleX, scaleY }) ---
// The white overlay (onDrawSurface drawRect) is drawn INSIDE the graphicsLayer,
// so it is clipped to the ORIGINAL capsule shape, then scaled with the layer.
// Computing the clip SDF in original space keeps the capsule clip correct when
// the button is stretched (no corner bleed, no stretched-clip artifacts).
uniform vec2  uOriginalSize;
uniform float uOriginalCornerRadius;
uniform vec2  uLayerScale;
uniform float uElementRotation;

${se}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    vec2 elementCenter = uOffset + uSize * 0.5;
    vec2 centeredScreen = screenCoord - elementCenter;
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    vec2 centeredOrig = centeredScreen / layerScale;
    vec2 origHalfSize = uOriginalSize * 0.5;
    vec2 centeredOrigRot = rotateBy(centeredOrig, -uElementRotation);

    // CLIP: for continuous-curvature (G2) elements, sample the R channel
    // (browser-native AA coverage) directly \u2014 this gives the most accurate
    // edge with NO exterior\u534A\u900F\u660E band. Using the G channel (SDF) with
    // smoothstep(-0.5, 0.5) leaves a ~1px half-transparent fringe OUTSIDE
    // the true shape edge (sd \u2208 [0, 0.5] is not discarded but has < 1
    // alpha), which lets the underlying glass body / shadow leak through
    // as a thin dark line ("capsule \u9ED1\u8FB9"). R coverage is 0 outside the
    // shape (browser AA only rasterizes the interior + edge), so the
    // fringe is eliminated and the clip is pixel-tight.
    // For G1 (analytic) elements, keep the SDF smoothstep \u2014 it's the
    // only shape source available.
    float clipAlpha;
    if (uUseContinuousSdf > 0.5) {
        clipAlpha = sampleClipMask(centeredOrigRot, origHalfSize, uOriginalCornerRadius);
    } else {
        float sd = sdRoundedRect(centeredOrigRot, origHalfSize, uOriginalCornerRadius);
        if (sd > 0.5) discard;
        clipAlpha = 1.0 - smoothstep(-0.5, 0.5, sd);
    }
    if (clipAlpha < 0.001) discard;

    gl_FragColor = vec4(uColor.rgb, uColor.a * clipAlpha);
}
`,$e=`
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uOffset;          // element top-left in canvas px (top-left origin) \u2014 SCALED rect
uniform vec2  uSize;            // element size in canvas px \u2014 SCALED (includes graphicsLayer scale)
uniform vec4  uCornerRadii;     // (topLeft, topRight, bottomRight, bottomLeft) in px \u2014 SCALED
uniform vec4  uHighlightColor;  // rgb + 1.0
uniform float uHighlightAngle;  // radians
uniform float uHighlightFalloff;
uniform float uHighlightAlpha;
uniform float uHighlightMode;     // 0=Default, 1=Ambient, 2=Plain
uniform float uHighlightStrokeWidth;
uniform float uHighlightBlur;
// --- ORIGINAL-SPACE SDF (faithful to graphicsLayer { scaleX, scaleY }) ---
// Same approach as the element shader: compute SDF/stroke in ORIGINAL space
// (shape is correct, not stretched), so the highlight clip + stroke remain a
// correct capsule shape that is then scaled by graphicsLayer. Without this,
// a horizontally-stretched button would stretch the highlight clip too,
// making the stroke band uneven. See element.ts for the full rationale.
uniform vec2  uOriginalSize;        // element size in px (ORIGINAL, unscaled)
uniform float uOriginalCornerRadius; // corner radius in px (ORIGINAL, unscaled)
uniform vec2  uLayerScale;          // (scaleX, scaleY) from graphicsLayer
uniform float uElementRotation;     // rotation in radians (graphicsLayer rotationZ)

${se}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    // elementCenter is the SAME for scaled and original rects (scaling is
    // around the center), so uOffset + uSize*0.5 gives the correct center.
    vec2 elementCenter = uOffset + uSize * 0.5;
    vec2 centeredScreen = screenCoord - elementCenter;
    // Map to ORIGINAL space (guard against divide-by-zero).
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    vec2 centeredOrig = centeredScreen / layerScale;
    // Un-rotate into the element's local space so the SDF shape rotates.
    vec2 centeredOrigRot = rotateBy(centeredOrig, -uElementRotation);

    vec2 origHalfSize = uOriginalSize * 0.5;
    float origRadius = uOriginalCornerRadius;

    // SDF for stroke \u2014 analytic sdRoundedRect (matches the pre-capsule
    // highlight implementation). When capsule is OFF, this is the exact
    // shape. When capsule is ON, this is a close approximation (circular
    // arc vs G2 Bezier \u2014 the difference is sub-pixel within the 2px stroke
    // band, invisible in the highlight).
    float sd = sdRoundedRect(centeredOrigRot, origHalfSize, origRadius);

    // Outside the shape \u2014 clip (hard discard, matching pre-capsule behavior).
    if (sd > 0.0) discard;

    // Stroke mask \u2014 faithful to HighlightModifier.kt:
    //   paint.style = Stroke
    //   paint.strokeWidth = ceil(width.toPx()) * 2     // full stroke, centered on edge
    //   paint.blur(blurRadius.toPx())                   // BlurMaskFilter, Blur.NORMAL
    //   canvas.clipOutline(outline)                     // clip to inside the shape
    //   canvas.drawOutline(outline, paint)              // stroke centered on edge
    //
    // Implementation: first compute a HARD-EDGE stroke mask (1.0 inside the
    // stroke band, 0.0 outside), then convolve it with a Gaussian kernel by
    // sampling the SDF at multiple offsets along the gradient direction.
    // This mirrors the original's two-step process (draw stroke \u2192 blur),
    // rather than using an analytic erf approximation.
    //
    // The hard stroke band: sd in [-strokeHalf, +strokeHalf].
    // After clip (sd > 0 discarded by the outer if), only [-strokeHalf, 0] shows.
    //
    // Faithful to the original BlurMaskFilter:
    //   paint.blur(blurRadius.toPx())  \u2192  BlurMaskFilter(NORMAL, sigma=blurRadius_px)
    // In Skia/Android, BlurMaskFilter's radius param IS the Gaussian sigma
    // (not radius/3). blurRadius = width/2 = 0.25dp, so sigma = 0.25*dpr px.
    // uHighlightBlur is already in device px (set by the renderer as widthDp*dpr*0.5).
    float strokeHalf = uHighlightStrokeWidth * 0.5;
    float sigma = max(uHighlightBlur, 0.1);

    // Gaussian convolution of the hard stroke mask \u2014 3-tap (\u03C3-spaced).
    // The original's BlurMaskFilter has \u03C3 = blurRadius = 0.25dp \u2192 0.25px at
    // dpr=1. At this sub-pixel sigma, only 3 taps (at -\u03C3, 0, +\u03C3) are needed
    // \u2014 the Gaussian weight at \xB12\u03C3 is exp(-2) \u2248 0.14, negligible. This
    // replaces the old 65-tap loop (which computed 65 exp() calls per pixel,
    // ~650 cycles \u2014 the single biggest shader cost). 3 taps = 3 exp() = ~30
    // cycles, a 20\xD7 reduction with identical visual result at \u03C3=0.25.
    //   hardMask(sd) = 1.0 if |sd| < strokeHalf, else 0.0
    //   blurred(sd) = \u03A3 hardMask(sd - offset_k) * gauss(offset_k, \u03C3)
    // CLIP HALVING: the stroke is centered on sd=0; clip removes sd>0 (outer
    // half), so peak \u2248 0.5. We halve to match.
    float strokeMask = 0.0;
    float wSum = 0.0;
    for (int i = -1; i <= 1; i++) {
        float offset = float(i) * sigma;  // taps at -\u03C3, 0, +\u03C3
        float sampleSd = sd - offset;
        float hard = (abs(sampleSd) < strokeHalf) ? 1.0 : 0.0;
        float w = exp(-0.5 * (offset * offset) / (sigma * sigma));
        strokeMask += hard * w;
        wSum += w;
    }
    strokeMask /= wSum;
    strokeMask *= 0.5;  // clip halves the symmetric stroke at the edge

    if (uHighlightMode < 0.5) {
        // Default \u2014 shader returns color * intensity, Plus blend.
        float gradRadius = min(origRadius * 1.5, min(origHalfSize.x, origHalfSize.y));
        vec2 grad = gradSdRoundedRect(centeredOrigRot, origHalfSize, gradRadius);
        vec2 normal = vec2(cos(uHighlightAngle), sin(uHighlightAngle));
        float d = dot(grad, normal);
        float intensity = pow(abs(d), uHighlightFalloff);
        vec3 c = uHighlightColor.rgb * intensity * strokeMask * uHighlightAlpha;
        gl_FragColor = vec4(c, 1.0);
    } else if (uHighlightMode < 1.5) {
        // Ambient \u2014 premultiplied SrcOver blend (renderer uses ONE, ONE_MINUS_SRC_ALPHA).
        // Faithful to AmbientHighlightShaderString:
        //   float d = dot(grad, normal);
        //   float intensity = pow(abs(d), falloff);
        //   float t = step(0.0, d);  \u2190 half-black-half-white split
        //   return half4(t, t, t, 1.0) * intensity;
        // Output is premultiplied: vec4(color.rgb * t * i, i).
        // Bright side: adds white light. Dark side: dims scene \u2192 3D sphere.
        // paint.color(0.38) is overridden by shader; alpha = 1.0 not 0.38.
        float gradRadius = min(origRadius * 1.5, min(origHalfSize.x, origHalfSize.y));
        vec2 grad = gradSdRoundedRect(centeredOrigRot, origHalfSize, gradRadius);
        vec2 normal = vec2(cos(uHighlightAngle), sin(uHighlightAngle));
        float d = dot(grad, normal);
        float intensity = pow(abs(d), uHighlightFalloff);
        float t = step(0.0, d);  // 0 on dark side (d<0), 1 on bright side (d>=0)
        float i = intensity * strokeMask * uHighlightAlpha;
        gl_FragColor = vec4(uHighlightColor.rgb * t * i, i);
    } else {
        // Plain \u2014 even stroke, paint.color, Plus blend.
        vec3 c = uHighlightColor.rgb * strokeMask * uHighlightAlpha;
        gl_FragColor = vec4(c, 1.0);
    }
}
`,je=`
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uOffset;          // element top-left (top-left origin) \u2014 SCALED
uniform vec2  uSize;            // element size \u2014 SCALED
uniform vec4  uCornerRadii;     // SCALED
uniform float uHighlightStrokeWidth;  // ceil(width*dpr)*2, device px
uniform vec2  uOriginalSize;
uniform float uOriginalCornerRadius;
uniform vec2  uLayerScale;
uniform float uElementRotation;
// uCornerStyle, uUseContinuousSdf, uContinuousSdf, uContinuousSdfTexSize,
// uContinuousSdfElementSize are declared in SDF_GLSL (do NOT redeclare here).

${se}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    vec2 elementCenter = uOffset + uSize * 0.5;
    vec2 centeredScreen = screenCoord - elementCenter;
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    vec2 centeredOrig = centeredScreen / layerScale;
    vec2 centeredOrigRot = rotateBy(centeredOrig, -uElementRotation);

    vec2 origHalfSize = uOriginalSize * 0.5;
    float origRadius = uOriginalCornerRadius;

    float sd = sdShape(centeredOrigRot, origHalfSize, origRadius);

    // clipOutline \u2014 clip to INSIDE the shape. Outside (sd > 0) is discarded.
    float edgeAA;
    if (uUseContinuousSdf > 0.5) {
        float mask = sampleClipMask(centeredOrigRot, origHalfSize, origRadius);
        if (mask < 0.01) discard;
        edgeAA = mask;
    } else {
        if (sd > 0.0) discard;
        edgeAA = 1.0 - smoothstep(-0.5, 0.5, sd);
    }

    // Stroke band centered on the edge (sd = 0), with 0.5px coverage AA on
    // the inner boundary. The outer boundary (sd = +strokeHalf) is clipped
    // away by edgeAA above. Faithful to Skia Paint.Stroke's coverage AA.
    // The BlurMaskFilter pass (when sigma >= 0.5px) softens this further;
    // at sub-pixel sigma (0.25px) the blur is skipped and this 0.5px AA
    // is what matches the original's look (Skia's 0.25px blur is negligibly
    // soft \u2014 essentially just AA).
    float strokeHalf = uHighlightStrokeWidth * 0.5;
    float strokeAA = 1.0 - smoothstep(strokeHalf - 0.5, strokeHalf, abs(sd));

    gl_FragColor = vec4(0.0, 0.0, 0.0, strokeAA * edgeAA);
}
`,Ze=`
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uOffset;
uniform vec2  uSize;
uniform vec4  uCornerRadii;
uniform sampler2D uBlurredMask;   // the 2-pass-blurred stroke mask FBO
uniform vec2  uMaskTexSize;       // size of the mask FBO (= canvas size)
uniform vec4  uHighlightColor;    // rgb + 1.0
uniform float uHighlightAngle;
uniform float uHighlightFalloff;
uniform float uHighlightAlpha;
uniform float uHighlightMode;     // 0=Default, 1=Ambient, 2=Plain
uniform vec2  uOriginalSize;
uniform float uOriginalCornerRadius;
uniform vec2  uLayerScale;
uniform float uElementRotation;
// uCornerStyle, uUseContinuousSdf, uContinuousSdf, uContinuousSdfTexSize,
// uContinuousSdfElementSize are declared in SDF_GLSL (do NOT redeclare here).

${se}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);

    // Sample the blurred stroke mask at this pixel. The mask FBO covers the
    // full canvas (same size), so UV = gl_FragCoord / maskTexSize.
    // Mask FBO is Y-down (top-left origin, like our scene FBOs), so flip Y
    // to match the screenCoord convention.
    vec2 maskUv = vec2(gl_FragCoord.x / uMaskTexSize.x, gl_FragCoord.y / uMaskTexSize.y);
    float mask = texture2D(uBlurredMask, maskUv).a;
    if (mask < 0.001) discard;

    // Compute intensity from the SDF gradient (AGSL DefaultHighlightShaderString).
    vec2 elementCenter = uOffset + uSize * 0.5;
    vec2 centeredScreen = screenCoord - elementCenter;
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    vec2 centeredOrig = centeredScreen / layerScale;
    vec2 centeredOrigRot = rotateBy(centeredOrig, -uElementRotation);
    vec2 origHalfSize = uOriginalSize * 0.5;
    float origRadius = uOriginalCornerRadius;

    // Faithful clip-after-blur: the original does clipOutline \u2192 stroke(blur),
    // but Skia applies clip at the canvas level AFTER the BlurMaskFilter
    // spreads alpha. So alpha that blurred OUTSIDE the shape is clipped away.
    // Our stroke shader clips before blur (discard sd>0), then blur spreads
    // alpha back outside \u2014 we must clip AGAIN here to match. Without this,
    // the highlight "leaks" outside the shape, making it brighter than the
    // original (which has zero contribution outside the clip region).
    float sd = sdShape(centeredOrigRot, origHalfSize, origRadius);
    float clipAA;
    if (uUseContinuousSdf > 0.5) {
        clipAA = sampleClipMask(centeredOrigRot, origHalfSize, origRadius);
    } else {
        clipAA = 1.0 - smoothstep(-0.5, 0.5, sd);
    }
    mask *= clipAA;
    if (mask < 0.001) discard;

    // Compute d (with sign) for Default + Ambient modes \u2014 needed for
    // Ambient's step(0,d) half-black-half-white split.
    float d = 0.0;  // signed dot(grad, normal) \u2014 0 for Plain mode
    float intensity;
    if (uHighlightMode < 1.5) {
        // Default + Ambient use the SDF gradient \xB7 normal.
        float gradRadius = min(origRadius * 1.5, min(origHalfSize.x, origHalfSize.y));
        vec2 grad = gradSdRoundedRect(centeredOrigRot, origHalfSize, gradRadius);
        vec2 normal = vec2(cos(uHighlightAngle), sin(uHighlightAngle));
        d = dot(grad, normal);
        intensity = pow(abs(d), uHighlightFalloff);
    } else {
        // Plain \u2014 no directional intensity (even stroke).
        intensity = 1.0;
    }

    float a = mask * uHighlightAlpha;

    if (uHighlightMode < 0.5) {
        // Default \u2014 Plus blend. Output premultiplied rgb (alpha=1 so blendFunc
        // (ONE, ONE) adds rgb directly).
        vec3 c = uHighlightColor.rgb * intensity * a;
        gl_FragColor = vec4(c, 1.0);
    } else if (uHighlightMode < 1.5) {
        // Ambient \u2014 PREMULTIPLIED SrcOver blend (renderer uses ONE, ONE_MINUS_SRC_ALPHA).
        // Faithful to AmbientHighlightShaderString:
        //   float t = step(0.0, d);  \u2190 half-black-half-white split
        // Bright side (d>=0): t=1 \u2192 white highlight. Dark side (d<0): t=0 \u2192
        // black overlay that reduces scene brightness via premultiplied SrcOver \u2192 3D sphere.
        // Output is premultiplied: vec4(color.rgb * t * i, i).
        // IMPORTANT: paint.color = White(0.38) is overridden by the shader.
        // The 0.38 does NOT scale the output; layer alpha (Highlight.alpha) is the
        // only modulation. For Ambient highlight, alpha = 1.0 (not 0.38).
        float t = step(0.0, d);
        float i = intensity * a;
        gl_FragColor = vec4(uHighlightColor.rgb * t * i, i);
    } else {
        // Plain \u2014 Plus blend, no intensity.
        vec3 c = uHighlightColor.rgb * a;
        gl_FragColor = vec4(c, 1.0);
    }
}
`,Qe=`
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uOffset;
uniform vec2  uSize;
uniform vec4  uCornerRadii;
uniform sampler2D uStrokeMask;
uniform vec2  uMaskOffset;
uniform vec2  uMaskSize;
uniform vec4  uHighlightColor;
uniform float uHighlightAngle;
uniform float uHighlightFalloff;
uniform float uHighlightAlpha;
uniform float uHighlightMode;
uniform vec2  uOriginalSize;
uniform float uOriginalCornerRadius;
uniform vec2  uLayerScale;
uniform float uElementRotation;

${se}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);

    // Map screen coord \u2192 element-local ORIGINAL space (un-scale, un-rotate).
    // The stroke mask is drawn in original space (origSizeX \xD7 origSizeY + margin).
    // elementCenter is the same in scaled and original space (scaling is around center).
    vec2 elementCenter = uOffset + uSize * 0.5;
    vec2 centeredScreen = screenCoord - elementCenter;
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    vec2 centeredOrig = centeredScreen / layerScale;
    vec2 centeredOrigRot = rotateBy(centeredOrig, -uElementRotation);

    // Mask UV: map original-space coord \u2192 mask texture UV.
    // The mask was drawn with translate(margin, margin), so mask (0,0) =
    // element-local (-margin). Element-local coord 0..origSize maps to
    // mask UV (0+margin)/maskSize .. (origSize+margin)/maskSize.
    // uMaskOffset = margin (scalar, passed as vec2 for convenience).
    // uMaskSize = (origSize + 2*margin).
    vec2 origHalfSize = uOriginalSize * 0.5;
    vec2 maskTexCoord = centeredOrigRot + origHalfSize;  // 0..origSize (element-local)
    vec2 maskUv = (maskTexCoord + uMaskOffset) / uMaskSize;
    if (maskUv.x < 0.0 || maskUv.x > 1.0 || maskUv.y < 0.0 || maskUv.y > 1.0) discard;
    float mask = texture2D(uStrokeMask, maskUv).a;
    if (mask < 0.001) discard;

    float origRadius = uOriginalCornerRadius;

    // Compute d (with sign) for Default + Ambient modes \u2014 needed for
    // Ambient's step(0,d) half-black-half-white split.
    float d = 0.0;  // signed dot(grad, normal) \u2014 0 for Plain mode
    float intensity;
    if (uHighlightMode < 1.5) {
        float gradRadius = min(origRadius * 1.5, min(origHalfSize.x, origHalfSize.y));
        vec2 grad = gradSdRoundedRect(centeredOrigRot, origHalfSize, gradRadius);
        vec2 normal = vec2(cos(uHighlightAngle), sin(uHighlightAngle));
        d = dot(grad, normal);
        intensity = pow(abs(d), uHighlightFalloff);
    } else {
        intensity = 1.0;
    }

    float a = mask * uHighlightAlpha;
    if (uHighlightMode < 0.5) {
        gl_FragColor = vec4(uHighlightColor.rgb * intensity * a, 1.0);
    } else if (uHighlightMode < 1.5) {
        // Ambient \u2014 premultiplied SrcOver (renderer uses ONE, ONE_MINUS_SRC_ALPHA).
        // Faithful to AmbientHighlightShaderString:
        //   float t = step(0.0, d);  \u2190 bright/dark split
        // Bright side: t=1 \u2192 white highlight. Dark side: t=0 \u2192 dims scene.
        // Output is premultiplied: vec4(color.rgb * t * i, i).
        // paint.color(0.38) is overridden by shader; alpha should be 1.0 not 0.38.
        float t = step(0.0, d);
        float i = intensity * a;
        gl_FragColor = vec4(uHighlightColor.rgb * t * i, i);
    } else {
        gl_FragColor = vec4(uHighlightColor.rgb * a, 1.0);
    }
}
`;var Je=`
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uOffset;           // element top-left in canvas px (top-left origin) \u2014 SCALED rect
uniform vec2  uSize;             // element size in canvas px \u2014 SCALED
uniform vec4  uCornerRadii;      // (topLeft, topRight, bottomRight, bottomLeft) \u2014 SCALED
uniform sampler2D uInnerShadowMask; // Canvas2D-generated blurred ring mask
uniform vec2  uMaskOffset;       // margin in device px (for UV mapping: element-local \u2192 mask UV)
uniform vec2  uMaskSize;         // total mask size in device px (w+2*margin, h+2*margin)
uniform vec3  uInnerShadowColor; // shadow color RGB
uniform float uInnerShadowAlpha; // shadow alpha
// --- ORIGINAL-SPACE SDF clip (faithful to graphicsLayer { scaleX, scaleY }) ---
uniform vec2  uOriginalSize;        // element size in px (ORIGINAL, unscaled)
uniform float uOriginalCornerRadius; // corner radius in px (ORIGINAL, unscaled)
uniform vec2  uLayerScale;          // (scaleX, scaleY) from graphicsLayer
uniform float uElementRotation;     // rotation in radians (graphicsLayer rotationZ)

${se}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);

    // Map screen coord \u2192 element-local ORIGINAL space (un-scale, un-rotate).
    // The inner shadow mask is drawn in original space (origSize + margin).
    // elementCenter is the same in scaled and original space (scaling is
    // around center).
    vec2 elementCenter = uOffset + uSize * 0.5;
    vec2 centeredScreen = screenCoord - elementCenter;
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    vec2 centeredOrig = centeredScreen / layerScale;
    vec2 centeredOrigRot = rotateBy(centeredOrig, -uElementRotation);

    // SDF for shape clip \u2014 faithful to InnerShadowModifier.kt's final
    // clipOutline call before drawLayer. The original uses Skia's
    // geometric clip with smooth AA (sub-pixel transition).
    // We replicate with smoothstep \u2014 NO hard discard.
    vec2 origHalfSize = uOriginalSize * 0.5;
    float sd = sdShape(centeredOrigRot, origHalfSize, uOriginalCornerRadius);

    // Smooth clipAlpha: 1.0 fully inside (sd \u2264 0), smoothly fading
    // across the boundary (sd 0\u21921.5), 0.0 outside (sd \u2265 1.5).
    // The 1.5px transition width matches Skia's clipOutline AA behavior
    // \u2014 pixels at the exact boundary (sd=0) retain FULL intensity, with
    // a gentle fade that removes outward blur leakage smoothly.
    // This is NOT a hard discard \u2014 it's a smooth clip that matches the
    // original's geometric clipOutline exactly.
    float clipAlpha = 1.0 - smoothstep(0.0, 1.5, sd);

    // Skip truly invisible pixels for performance (not a visual clip)
    if (clipAlpha < 0.004) discard;

    // Map to mask UV: original-space coord \u2192 mask texture UV.
    vec2 maskTexCoord = centeredOrigRot + origHalfSize;  // 0..origSize (element-local)
    vec2 maskUv = (maskTexCoord + uMaskOffset) / uMaskSize;

    // Sample the mask texture. CLAMP_TO_EDGE wrapping handles UV values
    // slightly outside (0..1) gracefully \u2014 returns transparent at edges.
    float mask = texture2D(uInnerShadowMask, maskUv).a;

    // Skip truly invisible pixels for performance (not a visual clip)
    // Threshold is very low to avoid cutting off faint but visible shadow edges.
    if (mask < 0.003) discard;

    // Premultiplied SrcOver composite: shadowColor \xD7 mask \xD7 shadowAlpha \xD7 clipAlpha.
    // clipAlpha provides smooth shape-boundary transition (faithful to original's
    // clipOutline AA). Output is premultiplied (rgb = color * alpha).
    // Renderer uses gl.blendFunc(ONE, ONE_MINUS_SRC_ALPHA) \u2014 premultiplied SrcOver.
    float a = mask * uInnerShadowAlpha * clipAlpha;
    gl_FragColor = vec4(uInnerShadowColor * a, a);
}
`;var Z=`
attribute vec2 aPos;
void main() {
    gl_Position = vec4(aPos, 0.0, 1.0);
}
`,et=`
precision highp float;

uniform sampler2D uBackdrop;
uniform vec2 uCanvasSize;
uniform vec2 uWallpaperSize;

${me}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    vec2 uv = coverUv(screenCoord);
    gl_FragColor = texture2D(uBackdrop, uv);
}
`,tt=`
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uCanvasSize;

void main() {
    vec2 uv = vec2(gl_FragCoord.x / uCanvasSize.x, gl_FragCoord.y / uCanvasSize.y);
    gl_FragColor = texture2D(uTexture, uv);
}
`,rt=`
precision highp float;

uniform vec4 uColor;

void main() {
    gl_FragColor = uColor;
}
`,st=`
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uSrcOffset;   // region top-left in source texture (top-left origin, device px)
uniform vec2 uSrcSize;     // fullscreen source texture size (device px)
uniform vec2 uDstSize;     // destination (small) FBO size = region size (device px)

void main() {
    vec2 localTopLeft = vec2(gl_FragCoord.x, uDstSize.y - gl_FragCoord.y);
    vec2 srcTopLeft = uSrcOffset + localTopLeft;
    vec2 uv = vec2(srcTopLeft.x / uSrcSize.x, 1.0 - srcTopLeft.y / uSrcSize.y);
    gl_FragColor = texture2D(uTexture, uv);
}
`,at=`
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uCanvasSize;     // bound FBO size in device px
uniform vec2 uElementCenter;  // element center (top-left origin, device px)
uniform vec2 uElementSize;    // SCALED element size (device px)
uniform float uRotation;      // element rotation in radians
uniform vec2 uSrcSize;        // elFbo texture size (baseline, device px)

// rotateBy \u2014 standard 2D rotation (counter-clockwise, math convention).
// Used consistently in Y-down (top-left origin) space \u2014 the Y-flip cancels
// because both element shader and composite use the same convention.
vec2 rotateBy(vec2 v, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}

void main() {
    // gl_FragCoord: bottom-left origin. Convert to top-left origin (Y-down).
    vec2 fragTopLeft = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    // Offset from element center (Y-down, screen px)
    vec2 centered = fragTopLeft - uElementCenter;
    // Un-rotate: screen \u2192 local (undo the element's rotation).
    // When rot\u22480 (common case \u2014 all non-GP elements), skip rotateBy entirely
    // (4 mul + cos/sin per fragment saved). This makes the composite shader
    // as cheap as the old 1:1 blit for the vast majority of elements.
    vec2 localCentered;
    if (abs(uRotation) > 0.001) {
        localCentered = rotateBy(centered, -uRotation);
    } else {
        localCentered = centered;
    }
    // Un-scale: screen px \u2192 elFbo px (baseline). Ratio = srcSize / elementSize.
    vec2 srcCentered = localCentered * uSrcSize / uElementSize;
    // Bounds check: discard if outside elFbo
    vec2 halfSrc = uSrcSize * 0.5;
    if (abs(srcCentered.x) > halfSrc.x || abs(srcCentered.y) > halfSrc.y) discard;
    // Map to UV. elFbo texture: UV (0,0) = gl_FragCoord (0,0) = bottom-left.
    // srcCentered is Y-down (top-left origin). Flip Y for texture UV.
    vec2 uv = vec2(
        (srcCentered.x + halfSrc.x) / uSrcSize.x,
        (halfSrc.y - srcCentered.y) / uSrcSize.y
    );
    gl_FragColor = texture2D(uTexture, uv);
}
`,ot=`
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uTexSize;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;

void main() {
    vec2 uv = vec2(gl_FragCoord.x / uTexSize.x, gl_FragCoord.y / uTexSize.y);
    vec4 c = texture2D(uTexture, uv);
    float invSat = 1.0 - uSaturation;
    float r = 0.213 * invSat;
    float g = 0.715 * invSat;
    float b = 0.072 * invSat;
    float t = (0.5 - uContrast * 0.5 + uBrightness);
    float cs = uContrast * uSaturation;
    float cr = uContrast * r;
    float cg = uContrast * g;
    float cb = uContrast * b;
    vec3 outc;
    outc.r = (cr + cs) * c.r + cg * c.g + cb * c.b + t;
    outc.g = cr * c.r + (cg + cs) * c.g + cb * c.b + t;
    outc.b = cr * c.r + cg * c.g + (cb + cs) * c.b + t;
    gl_FragColor = vec4(outc, c.a);
}
`,it=`
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uCanvasSize;
uniform vec3 uTintColor;   // rgb 0..1 (accentColor)

// ColorFilter.tint(color, blendMode = BlendMode.SrcIn):
//   result.rgb = src.rgb (the tint color)
//   result.a   = dst.a * src.a
// SrcIn replaces the destination's RGB with the tint color while
// preserving its alpha \u2014 opaque content becomes solid tint, transparent
// areas stay transparent. This matches Compose's ColorFilter.tint default.
void main() {
    vec2 uv = vec2(gl_FragCoord.x / uCanvasSize.x, gl_FragCoord.y / uCanvasSize.y);
    vec4 src = texture2D(uTexture, uv);
    gl_FragColor = vec4(uTintColor, src.a);
}
`;var nt=`
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uCanvasSize;
uniform vec2 uOffset;   // foreground texture top-left in canvas px (top-left origin) \u2014 SCALED rect
uniform vec2 uSize;     // foreground texture size in canvas px \u2014 SCALED
uniform vec4 uCornerRadii;  // capsule radii (topLeft, topRight, bottomRight, bottomLeft) in px \u2014 SCALED
uniform float uAlpha;   // global alpha multiplier (used for press fade)
// --- ORIGINAL-SPACE SDF clip (faithful to graphicsLayer { scaleX, scaleY }) ---
// The original wraps everything (text included) in a graphicsLayer clipped to
// the capsule shape, THEN scales the layer. So the clip shape is the ORIGINAL
// capsule, not the stretched one. We compute the clip SDF in original space so
// a stretched button keeps correct capsule clipping (no corner bleed). The
// texture UV still uses the scaled rect (uOffset/uSize) since the foreground
// texture is rendered at the element's scaled on-screen size.
uniform vec2  uOriginalSize;        // element size in px (ORIGINAL, unscaled)
uniform float uOriginalCornerRadius; // corner radius in px (ORIGINAL, unscaled)
uniform vec2  uLayerScale;          // (scaleX, scaleY) from graphicsLayer

${se}

void main() {
    // gl_FragCoord is bottom-left origin in WebGL framebuffer space.
    // Flip Y to get top-left origin (matching CSS / 2D canvas convention).
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    vec2 localCoord = screenCoord - uOffset;
    // Scissor to the (scaled) foreground rectangle.
    if (localCoord.x < 0.0 || localCoord.x > uSize.x ||
        localCoord.y < 0.0 || localCoord.y > uSize.y) {
        discard;
    }

    // --- Capsule clip in ORIGINAL space (faithful to graphicsLayer clip) ---
    // elementCenter is the SAME for scaled and original rects (scaling is
    // around the center). Map screen coord \u2192 original space for the SDF so
    // the clip shape is the original capsule, not the stretched one.
    vec2 elementCenter = uOffset + uSize * 0.5;
    vec2 centeredScreen = screenCoord - elementCenter;
    vec2 layerScale = max(uLayerScale, vec2(1e-4));
    vec2 centeredOrig = centeredScreen / layerScale;
    vec2 origHalfSize = uOriginalSize * 0.5;
    float clipAlpha;
    if (uUseContinuousSdf > 0.5) {
        float mask = sampleClipMask(centeredOrig, origHalfSize, uOriginalCornerRadius);
        if (mask < 0.01) discard;
        clipAlpha = mask;
    } else {
        float sdClip = sdClipShape(centeredOrig, origHalfSize, uOriginalCornerRadius);
        if (sdClip > 0.5) discard;
        clipAlpha = 1.0 - smoothstep(-0.5, 0.5, sdClip);
    }

    // The texture is uploaded from a 2D canvas with UNPACK_FLIP_Y_WEBGL=false,
    // so texture row 0 (= v=0) is the TOP row of the source canvas. Combined
    // with the Y flip above, uv.y=0 corresponds to the top of the button rect
    // (which is what we want \u2014 text drawn at the middle of the source canvas
    // appears at the middle of the button).
    //
    // The texture is uploaded with UNPACK_PREMULTIPLY_ALPHA_WEBGL=true, so
    // c is already in premultiplied form (c.rgb <= c.a). We scale both
    // rgb and a by uAlpha * clipAlpha and output premultiplied rgba, paired
    // with blendFunc(ONE, ONE_MINUS_SRC_ALPHA) at the draw site.
    vec2 uv = localCoord / uSize;
    vec4 c = texture2D(uTexture, uv);
    float a = c.a * uAlpha * clipAlpha;
    gl_FragColor = vec4(c.rgb * uAlpha * clipAlpha, a);
}
`,lt=`
precision highp float;

uniform vec2  uCanvasSize;
uniform vec2  uOffset;
uniform vec2  uSize;
uniform vec4  uCornerRadii;
uniform vec4  uColor;       // rgba (premultiplied not required; alpha used as-is)

${se}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    vec2 localCoord = screenCoord - uOffset;
    vec2 halfSize = uSize * 0.5;
    vec2 centeredCoord = localCoord - halfSize;

    float radius = radiusAt(centeredCoord, uCornerRadii);
    float alpha;
    if (uUseContinuousSdf > 0.5) {
        float mask = sampleClipMask(centeredCoord, halfSize, radius);
        if (mask < 0.01) discard;
        alpha = mask;
    } else {
        float sdClip = sdClipShape(centeredCoord, halfSize, radius);
        if (sdClip > 0.5) discard;
        alpha = 1.0 - smoothstep(-0.5, 0.5, sdClip);
    }
    gl_FragColor = vec4(uColor.rgb, uColor.a * alpha);
}
`,ut=`
precision highp float;

uniform sampler2D uBackdrop;
uniform vec2  uCanvasSize;
uniform vec2  uWallpaperSize;
uniform vec2  uOffset;          // band top-left in canvas px (top-left origin)
uniform vec2  uSize;            // band size in canvas px
uniform float uBlurRadius;      // px in canvas space
uniform vec4  uTintColor;       // rgba
uniform float uTintIntensity;   // 0..1

${me}

// 9-tap poisson disc \u2014 offsets are inlined because GLSL ES 1.00 (WebGL 1)
// does not support array constructors or const-array initializers.
// The offsets are normalized (unit disc), multiplied by step (radius in UV).
vec4 sampleBackdrop(vec2 canvasPx, float radius) {
    vec2 uvScale = canvasPxToUvScale();
    vec2 uv = coverUv(canvasPx);
    vec2 st = radius * uvScale;
    vec4 sum = vec4(0.0);
    sum += texture2D(uBackdrop, uv + vec2( 0.0000,  0.0000) * st);
    sum += texture2D(uBackdrop, uv + vec2( 0.5000,  0.0000) * st);
    sum += texture2D(uBackdrop, uv + vec2(-0.5000,  0.0000) * st);
    sum += texture2D(uBackdrop, uv + vec2( 0.0000,  0.5000) * st);
    sum += texture2D(uBackdrop, uv + vec2( 0.0000, -0.5000) * st);
    sum += texture2D(uBackdrop, uv + vec2( 0.3536,  0.3536) * st);
    sum += texture2D(uBackdrop, uv + vec2(-0.3536,  0.3536) * st);
    sum += texture2D(uBackdrop, uv + vec2( 0.3536, -0.3536) * st);
    sum += texture2D(uBackdrop, uv + vec2(-0.3536, -0.3536) * st);
    return sum / 9.0;
}

void main() {
    vec2 screenCoord = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
    vec2 localCoord = screenCoord - uOffset;
    // Outside the band \u2014 nothing to draw.
    if (localCoord.x < 0.0 || localCoord.x > uSize.x ||
        localCoord.y < 0.0 || localCoord.y > uSize.y) {
        discard;
    }

    // Alpha mask: opaque at top (coord.y = size.y, i.e. BOTTOM in top-left
    // origin = size.y in AGSL coord), transparent at bottom. Matches the
    // Kotlin smoothstep(size.y, size.y * 0.5, coord.y).
    float a = smoothstep(uSize.y, uSize.y * 0.5, localCoord.y);

    // Sample the (cover-fit) backdrop at the canvas pixel, blurred.
    vec4 blurred = sampleBackdrop(screenCoord, uBlurRadius);

    // Faithful to AlphaMask shader: mix(content * blurAlpha, tint * tintAlpha, tintIntensity)
    // This is PREMULTIPLIED (rgb already scaled by alpha). The renderer uses
    // premultiplied alpha blending for the progressive blur pass, so we output
    // premultiplied rgb with the mask alpha.
    vec3 premulRgb = mix(blurred.rgb * a, uTintColor.rgb * a, uTintIntensity);
    gl_FragColor = vec4(premulRgb, a);
}
`;function Jr(e){if(e<=1)return[{offset:0,weight:1}];let r=[],t=Math.floor(e/2),s=3,a=0;for(let o=0;o<e;o++){let i=(e%2===1?o-t:o-t+.5)/t*s,l=Math.exp(-.5*i*i);r.push({offset:i,weight:l}),a+=l}if(a>0)for(let o of r)o.weight/=a;return r}function ct(e,r){let t=Jr(e),a=r==="horizontal"?"vec2(1.0, 0.0)":"vec2(0.0, 1.0)",o="";if(t.length===1)o=`    gl_FragColor = texture2D(uTexture, uv);
`;else{o=`    vec3 rgbSum = vec3(0.0);
    float rgbW = 0.0;
`;for(let n of t){let i=n.offset.toFixed(6),l=n.weight.toFixed(8);o+=`    { vec4 s = texture2D(uTexture, uv + ${a} * ${i} * pxToUv); float aw = s.a * ${l}; rgbSum += s.rgb * aw; rgbW += aw; }
`}o+=`    float origA = texture2D(uTexture, uv).a;
    gl_FragColor = vec4(rgbW > 0.001 ? rgbSum / rgbW : vec3(0.0), origA);
`}return`
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uTexSize;
uniform float uRadius;

void main() {
    vec2 uv = vec2(gl_FragCoord.x / uTexSize.x, gl_FragCoord.y / uTexSize.y);
    if (uRadius < 0.5) {
        gl_FragColor = texture2D(uTexture, uv);
        return;
    }
    vec2 pxToUv = vec2(uRadius / uTexSize.x, uRadius / uTexSize.y);
${o}}
`}function Re(e){if(e<.5)return 1;let r=e*.57735+.5,t=2*Math.ceil(3*r)+1;return Math.min(33,Math.max(1,t))}function es(e){if(e<=1)return[{offset:0,weight:1}];let r=[],t=Math.floor(e/2),s=0;for(let a=0;a<e;a++){let o=a-t,n=Math.exp(-.5*o*o);r.push({offset:o,weight:n}),s+=n}if(s>0)for(let a of r)a.weight/=s;return r}function dt(e,r){let t=es(e),a=r==="horizontal"?"vec2(1.0, 0.0)":"vec2(0.0, 1.0)",o="";if(t.length===1)o=`    gl_FragColor = texture2D(uTexture, uv);
`;else{o=`    float aSum = 0.0;
`;for(let n of t){let i=n.offset.toFixed(6),l=n.weight.toFixed(8);o+=`    aSum += texture2D(uTexture, uv + ${a} * ${i} * pxToUv).a * ${l};
`}o+=`    gl_FragColor = vec4(0.0, 0.0, 0.0, aSum);
`}return`
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uTexSize;
uniform float uRadius;  // Gaussian sigma in pixels (Android BlurMaskFilter semantics)

void main() {
    vec2 uv = vec2(gl_FragCoord.x / uTexSize.x, gl_FragCoord.y / uTexSize.y);
    if (uRadius < 0.01) {
        gl_FragColor = texture2D(uTexture, uv);
        return;
    }
    // pxToUv converts a pixel offset to a UV offset. offset (in \u03C3 units) *
    // sigma_px = pixel offset; / uTexSize = UV offset.
    vec2 pxToUv = vec2(uRadius / uTexSize.x, uRadius / uTexSize.y);
${o}}
`}function ht(e){if(e<.01)return 1;let r=2*Math.ceil(3*e)+1;return Math.min(33,Math.max(3,r))}function ye(e,r=1){let t;e<1.5?t=2:e<3?t=3:e<6?t=4:e<12?t=6:t=8;let s=Math.round(t*r);return Math.max(2,Math.min(8,s))}function ft(){return`precision highp float;
uniform sampler2D uTexture;
uniform vec2 uTexSize;
uniform float uRadius;      // target Gaussian \u03C3 (px) \u2014 Kawase accumulates to match
uniform float uIteration;   // current iteration index, 0-based
uniform float uTotalIters;  // total iteration count N
void main() {
    vec2 uv = vec2(gl_FragCoord.x / uTexSize.x, gl_FragCoord.y / uTexSize.y);
    vec2 pxToUv = vec2(1.0 / uTexSize.x, 1.0 / uTexSize.y);
    // d_max = radius \xD7 \u221A(6N / ((N+1)(2N+1))) \u2014 variance-matched to Gaussian \u03C3.
    // d_i = d_max \xD7 (i+1)/N.
    float N = uTotalIters;
    float dMax = uRadius * sqrt(6.0 * N / ((N + 1.0) * (2.0 * N + 1.0)));
    float d = dMax * (uIteration + 1.0) / N;
    vec2 off = vec2(d, d) * pxToUv;
    // 4 diagonal taps (Kawase original): equal weight 0.25 each.
    vec4 s1 = texture2D(uTexture, uv + off);
    vec4 s2 = texture2D(uTexture, uv - off);
    vec4 s3 = texture2D(uTexture, uv + vec2(off.x, -off.y));
    vec4 s4 = texture2D(uTexture, uv + vec2(-off.x, off.y));
    // Premul-aware: RGB weighted by sample alpha, alpha = center.
    float aw1 = s1.a, aw2 = s2.a, aw3 = s3.a, aw4 = s4.a;
    float awSum = aw1 + aw2 + aw3 + aw4;
    vec3 rgb = awSum > 0.001 ? (s1.rgb * aw1 + s2.rgb * aw2 + s3.rgb * aw3 + s4.rgb * aw4) / awSum : vec3(0.0);
    float origA = texture2D(uTexture, uv).a;
    gl_FragColor = vec4(rgb, origA);
}
`}function ge(e,r,t){let s=e.createShader(r);if(e.shaderSource(s,t),e.compileShader(s),!e.getShaderParameter(s,e.COMPILE_STATUS)){let a=e.getShaderInfoLog(s);throw e.deleteShader(s),new Error("Shader compile error: "+a)}return s}function J(e,r,t){let s=ge(e,e.VERTEX_SHADER,r),a=ge(e,e.FRAGMENT_SHADER,t),o=e.createProgram();if(e.attachShader(o,s),e.attachShader(o,a),e.linkProgram(o),!e.getProgramParameter(o,e.LINK_STATUS)){let n=e.getProgramInfoLog(o);throw e.deleteProgram(o),new Error("Program link error: "+n)}return o}function ee(e,r,t,s,a){let o=[];for(let n of s){let i=e.getUniformLocation(r,n);a[n]=i,i===null&&o.push(n)}o.length>0}function mt(e,r,t){let s=r.split(/\s+/).filter(n=>n.length>0),a=[],o="";for(let n of s){let i=o?o+" "+n:n;if(e.measureText(i).width<=t){o=i;continue}o&&(a.push(o),o="");for(let l of n){let d=o+l;e.measureText(d).width<=t||!o?o=d:(a.push(o),o=l)}}return o&&a.push(o),a}function pe(e){if(e<=0)return 0;if(e>=1)return 1;let r=.42,t=0,s=1,a=1,o=e;for(let n=0;n<8;n++){let i=3*(1-o)*(1-o)*o*r+3*(1-o)*o*o*s+o*o*o,l=3*(1-o)*(1-o)*r+6*(1-o)*o*(s-r)+3*o*o*(1-s);if(Math.abs(i-e)<.001||Math.abs(l)<1e-6)break;o-=(i-e)/l,o=Math.max(0,Math.min(1,o))}return 3*(1-o)*(1-o)*o*t+3*(1-o)*o*o*a+o*o*o}var _e=class{constructor(){this.enabled=!1;this.gl=null;this.HISTORY_SIZE=240;this.frameTimes=new Float32Array(this.HISTORY_SIZE);this.frameTimeIdx=0;this.frameTimeCount=0;this.prevFrameEndTime=0;this.totalFrames=0;this.jank16Count=0;this.jank33Count=0;this.drawCalls=0;this.glassElements=0;this.perElementFboCount=0;this.pingPongCount=0;this.nonGlassElements=0;this.blurPasses=0;this.dirtyElements=0;this.totalElements=0;this.cachedElements=0;this.lastDrawCalls=0;this.lastGlassElements=0;this.lastPerElementFboCount=0;this.lastPingPongCount=0;this.lastNonGlassElements=0;this.lastBlurPasses=0;this.lastDirtyElements=0;this.lastTotalElements=0;this.lastCachedElements=0;this.lastFrameTimeMs=0;this.gpuInfoCollected=!1;this.gpuVendor="";this.gpuRenderer="";this.maxTextureSize=0;this.extensionCount=0;this.isSoftwareRenderer=!1;this.canvasCssW=0;this.canvasCssH=0;this.canvasDevW=0;this.canvasDevH=0;this.dpr=0;this.deviceDpr=0}attachGl(r){this.gl=r}collectGpuInfo(){if(!this.gl||this.gpuInfoCollected)return;this.gpuInfoCollected=!0;let r=this.gl,t=r.getExtension("WEBGL_debug_renderer_info");try{this.gpuVendor=String(t?r.getParameter(t.UNMASKED_VENDOR_WEBGL)||"":r.getParameter(r.VENDOR)||""),this.gpuRenderer=String(t?r.getParameter(t.UNMASKED_RENDERER_WEBGL)||"":r.getParameter(r.RENDERER)||""),this.maxTextureSize=Number(r.getParameter(r.MAX_TEXTURE_SIZE))||0;let s=r.getSupportedExtensions()||[];this.extensionCount=s.length}catch{}}frameStart(){this.enabled&&(this.collectGpuInfo(),this.drawCalls=0,this.glassElements=0,this.perElementFboCount=0,this.pingPongCount=0,this.nonGlassElements=0,this.blurPasses=0,this.dirtyElements=0,this.totalElements=0,this.cachedElements=0)}frameEnd(){if(!this.enabled)return;let r=performance.now(),t=this.prevFrameEndTime>0?r-this.prevFrameEndTime:0;this.prevFrameEndTime=r,t>0&&t<=500&&(this.lastFrameTimeMs=t,this.frameTimes[this.frameTimeIdx]=t,this.frameTimeIdx=(this.frameTimeIdx+1)%this.HISTORY_SIZE,this.frameTimeCount<this.HISTORY_SIZE&&this.frameTimeCount++,t>16.67&&this.jank16Count++,t>33.33&&this.jank33Count++),this.totalFrames++,this.lastDrawCalls=this.drawCalls,this.lastGlassElements=this.glassElements,this.lastPerElementFboCount=this.perElementFboCount,this.lastPingPongCount=this.pingPongCount,this.lastNonGlassElements=this.nonGlassElements,this.lastBlurPasses=this.blurPasses,this.lastDirtyElements=this.dirtyElements,this.lastTotalElements=this.totalElements,this.lastCachedElements=this.cachedElements}incDrawCall(r=1){this.enabled&&(this.drawCalls+=r)}incGlassElement(){this.enabled&&this.glassElements++}incPerElementFbo(){this.enabled&&this.perElementFboCount++}incPingPong(){this.enabled&&this.pingPongCount++}incNonGlass(){this.enabled&&this.nonGlassElements++}incBlurPass(){this.enabled&&this.blurPasses++}incDirty(){this.enabled&&this.dirtyElements++}incTotal(){this.enabled&&this.totalElements++}incCachedElement(){this.enabled&&this.cachedElements++}reset(){this.frameTimes.fill(0),this.frameTimeIdx=0,this.frameTimeCount=0,this.prevFrameEndTime=0,this.totalFrames=0,this.jank16Count=0,this.jank33Count=0,this.lastFrameTimeMs=0,this.lastDrawCalls=0,this.lastGlassElements=0,this.lastPerElementFboCount=0,this.lastPingPongCount=0,this.lastNonGlassElements=0,this.lastBlurPasses=0,this.lastDirtyElements=0,this.lastTotalElements=0,this.lastCachedElements=0}getSnapshot(){let r=[];if(this.frameTimeCount>0)if(this.frameTimeCount<this.HISTORY_SIZE)for(let l=0;l<this.frameTimeCount;l++)r.push(this.frameTimes[l]);else for(let l=0;l<this.HISTORY_SIZE;l++)r.push(this.frameTimes[(this.frameTimeIdx+l)%this.HISTORY_SIZE]);let t=0,s=1/0,a=0;for(let l of r)t+=l,l<s&&(s=l),l>a&&(a=l);let o=r.length,n=o>0?t/o:0,i=this.lastFrameTimeMs;return{frameTimeMs:i,avgFrameTimeMs:n,minFrameTimeMs:o>0?s:0,maxFrameTimeMs:o>0?a:0,fps:i>0?1e3/i:0,avgFps:n>0?1e3/n:0,jank16Count:this.jank16Count,jank33Count:this.jank33Count,totalFrames:this.totalFrames,drawCalls:this.lastDrawCalls,glassElements:this.lastGlassElements,perElementFboCount:this.lastPerElementFboCount,pingPongCount:this.lastPingPongCount,nonGlassElements:this.lastNonGlassElements,blurPasses:this.lastBlurPasses,dirtyElements:this.lastDirtyElements,totalElements:this.lastTotalElements,cachedElements:this.lastCachedElements,gpuVendor:this.gpuVendor,gpuRenderer:this.gpuRenderer,maxTextureSize:this.maxTextureSize,extensionCount:this.extensionCount,isSoftwareRenderer:this.isSoftwareRenderer,canvasCssW:this.canvasCssW,canvasCssH:this.canvasCssH,canvasDevW:this.canvasDevW,canvasDevH:this.canvasDevH,dpr:this.dpr,deviceDpr:this.deviceDpr,pixelsPerFrame:this.canvasDevW*this.canvasDevH,history:r,timestamp:performance.now()}}};var qt={createFBO(e,r){let t=this.gl,s=t.createTexture();t.bindTexture(t.TEXTURE_2D,s),t.texImage2D(t.TEXTURE_2D,0,t.RGBA,e,r,0,t.RGBA,t.UNSIGNED_BYTE,null),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE);let a=t.createFramebuffer();return t.bindFramebuffer(t.FRAMEBUFFER,a),t.framebufferTexture2D(t.FRAMEBUFFER,t.COLOR_ATTACHMENT0,t.TEXTURE_2D,s,0),t.bindFramebuffer(t.FRAMEBUFFER,null),{fb:a,tex:s}},resizeFBOs(e,r,t=!1){if(!t&&this.fboW===e&&this.fboH===r&&this.fboA&&this.fboB)return;let s=this.gl;this.fboA&&s.deleteFramebuffer(this.fboA),this.fboATex&&s.deleteTexture(this.fboATex),this.fboB&&s.deleteFramebuffer(this.fboB),this.fboBTex&&s.deleteTexture(this.fboBTex);let a=this.createFBO(e,r),o=this.createFBO(e,r);this.fboA=a.fb,this.fboATex=a.tex,this.fboB=o.fb,this.fboBTex=o.tex,this.tabsBackdropFbo&&s.deleteFramebuffer(this.tabsBackdropFbo),this.tabsBackdropTex&&s.deleteTexture(this.tabsBackdropTex);let n=this.createFBO(e,r);this.tabsBackdropFbo=n.fb,this.tabsBackdropTex=n.tex,this.tabsBackdropDirty=!0,this.wallpaperBlurFbo&&s.deleteFramebuffer(this.wallpaperBlurFbo),this.wallpaperBlurTex&&s.deleteTexture(this.wallpaperBlurTex),this.blurFboA&&s.deleteFramebuffer(this.blurFboA),this.blurFboATex&&s.deleteTexture(this.blurFboATex),this.blurFboB&&s.deleteFramebuffer(this.blurFboB),this.blurFboBTex&&s.deleteTexture(this.blurFboBTex),this.dsBlurFboA&&s.deleteFramebuffer(this.dsBlurFboA),this.dsBlurFboATex&&s.deleteTexture(this.dsBlurFboATex),this.dsBlurFboB&&s.deleteFramebuffer(this.dsBlurFboB),this.dsBlurFboBTex&&s.deleteTexture(this.dsBlurFboBTex);for(let S of this.dsBlurLevels)s.deleteFramebuffer(S.fboA),s.deleteTexture(S.texA),s.deleteFramebuffer(S.fboB),s.deleteTexture(S.texB);this.dsBlurLevels=[];let i=Math.max(1,this.blurDownsample),l=i<=1?1:Math.max(1,Math.min(i*(this.dpr||1),64));this.effectiveBlurDownsample=l;let d=this.createFBO(e,r),c=this.createFBO(e,r),u=this.createFBO(e,r);this.wallpaperBlurFbo=d.fb,this.wallpaperBlurTex=d.tex,this.blurFboA=c.fb,this.blurFboATex=c.tex,this.blurFboB=u.fb,this.blurFboBTex=u.tex;let h=Math.max(1,Math.floor(e/l)),f=Math.max(1,Math.floor(r/l)),b=this.createFBO(h,f),m=this.createFBO(h,f);this.dsBlurFboA=b.fb,this.dsBlurFboATex=b.tex,this.dsBlurFboB=m.fb,this.dsBlurFboBTex=m.tex,this.dsBlurFboW=h,this.dsBlurFboH=f;let g=[];for(let S=1;S<=l;S*=2)g.push(S);for(let S of g){let C=Math.max(1,Math.floor(e/S)),M=Math.max(1,Math.floor(r/S)),L=this.createFBO(C,M),R=this.createFBO(C,M);this.dsBlurLevels.push({ds:S,fboA:L.fb,texA:L.tex,fboB:R.fb,texB:R.tex,w:C,h:M})}this.highlightMaskFbo&&s.deleteFramebuffer(this.highlightMaskFbo),this.highlightMaskTex&&s.deleteTexture(this.highlightMaskTex);let T=this.createFBO(e,r);this.highlightMaskFbo=T.fb,this.highlightMaskTex=T.tex,this.dialogBackdropFbo&&s.deleteFramebuffer(this.dialogBackdropFbo),this.dialogBackdropTex&&s.deleteTexture(this.dialogBackdropTex);let p=this.createFBO(e,r);this.dialogBackdropFbo=p.fb,this.dialogBackdropTex=p.tex,this.dialogBackdropKey=null,this.bgOnlyFbo&&s.deleteFramebuffer(this.bgOnlyFbo),this.bgOnlyTex&&s.deleteTexture(this.bgOnlyTex);let x=this.createFBO(e,r);this.bgOnlyFbo=x.fb,this.bgOnlyTex=x.tex;let v=this.fboW!==e||this.fboH!==r;this.fboW=e,this.fboH=r,v&&this.clearBackdropBlurCache()},clearBackdropBlurCache(){let e=this.gl;for(let r of this.backdropBlurCache.values())e.deleteTexture(r.tex),e.deleteFramebuffer(r.fb);this.backdropBlurCache.clear();for(let r of this.backdropBlurCacheFboPool)e.deleteTexture(r.tex),e.deleteFramebuffer(r.fb);this.backdropBlurCacheFboPool.length=0,this.backdropBlurCacheSnapshots.length=0,this.cacheCopyReadFbo&&(e.deleteFramebuffer(this.cacheCopyReadFbo),this.cacheCopyReadFbo=null)},evictBackdropBlurCacheIfNeeded(){for(;this.backdropBlurCache.size>this.backdropBlurCacheMax;){let e=this.backdropBlurCache.keys().next().value;if(!e)break;let r=this.backdropBlurCache.get(e);r&&this.releaseCacheFBO(r),this.backdropBlurCache.delete(e)}for(;this.backdropBlurCacheSnapshots.length>this.backdropBlurCacheMax;)this.backdropBlurCacheSnapshots.shift()},acquireCacheFBO(e,r){let t=this.backdropBlurCacheFboPool;for(let a=t.length-1;a>=0;a--){let o=t[a];if(o.w===e&&o.h===r)return t.splice(a,1),o}let s=this.createFBO(e,r);return{fb:s.fb,tex:s.tex,w:e,h:r}},releaseCacheFBO(e){this.backdropBlurCacheFboPool.push(e)},bindFBO(e){let r=this.gl;r.bindFramebuffer(r.FRAMEBUFFER,e),r.viewport(0,0,this.fboW,this.fboH)},drawCopy(e){let r=this.gl;r.useProgram(this.copyProgram),r.bindBuffer(r.ARRAY_BUFFER,this.quadBuffer),r.enableVertexAttribArray(this.aPosLocCp),r.vertexAttribPointer(this.aPosLocCp,2,r.FLOAT,!1,0,0),r.activeTexture(r.TEXTURE0),r.bindTexture(r.TEXTURE_2D,e),r.uniform1i(this.uCp.uTexture,0),r.uniform2f(this.uCp.uCanvasSize,this.fboW,this.fboH),r.disable(r.BLEND),r.drawArrays(r.TRIANGLES,0,6)},drawSolidFill(e,r,t,s){let a=this.gl;a.useProgram(this.solidFillProgram),a.bindBuffer(a.ARRAY_BUFFER,this.quadBuffer),a.enableVertexAttribArray(this.aPosLocSf),a.vertexAttribPointer(this.aPosLocSf,2,a.FLOAT,!1,0,0),a.uniform4f(this.uSf.uColor,e,r,t,s),a.disable(a.BLEND),a.drawArrays(a.TRIANGLES,0,6)},drawColorControls(e,r,t,s){let a=this.gl;a.useProgram(this.colorControlsProgram),a.bindBuffer(a.ARRAY_BUFFER,this.quadBuffer),a.enableVertexAttribArray(this.aPosLocCc),a.vertexAttribPointer(this.aPosLocCc,2,a.FLOAT,!1,0,0),a.activeTexture(a.TEXTURE0),a.bindTexture(a.TEXTURE_2D,e),a.uniform1i(this.uCc.uTexture,0),a.uniform2f(this.uCc.uTexSize,this.fboW,this.fboH),a.uniform1f(this.uCc.uBrightness,r),a.uniform1f(this.uCc.uContrast,t),a.uniform1f(this.uCc.uSaturation,s),a.disable(a.BLEND),a.drawArrays(a.TRIANGLES,0,6)},ensureElementFBO(e,r){let t=Math.max(1,Math.round(e)),s=Math.max(1,Math.round(r));if(this.elFboW===t&&this.elFboH===s&&this.elFbo&&this.backdropCropFbo&&this.elBlurFboA&&this.elBlurFboB)return{w:t,h:s};let a=this.gl;this.elFbo&&a.deleteFramebuffer(this.elFbo),this.elFboTex&&a.deleteTexture(this.elFboTex);let o=this.createFBO(t,s);this.elFbo=o.fb,this.elFboTex=o.tex,this.backdropCropFbo&&a.deleteFramebuffer(this.backdropCropFbo),this.backdropCropTex&&a.deleteTexture(this.backdropCropTex);let n=this.createFBO(t,s);this.backdropCropFbo=n.fb,this.backdropCropTex=n.tex,this.elBlurFboA&&a.deleteFramebuffer(this.elBlurFboA),this.elBlurFboATex&&a.deleteTexture(this.elBlurFboATex),this.elBlurFboB&&a.deleteFramebuffer(this.elBlurFboB),this.elBlurFboBTex&&a.deleteTexture(this.elBlurFboBTex);let i=this.createFBO(t,s),l=this.createFBO(t,s);return this.elBlurFboA=i.fb,this.elBlurFboATex=i.tex,this.elBlurFboB=l.fb,this.elBlurFboBTex=l.tex,this.elFboW=t,this.elFboH=s,{w:t,h:s}},cropAndBlurBackdrop(e,r,t,s,a,o){let n=this.gl,i=this.elFboW,l=this.elFboH;if(n.bindFramebuffer(n.FRAMEBUFFER,this.backdropCropFbo),n.viewport(0,0,i,l),n.disable(n.BLEND),n.useProgram(this.elFboCropProgram),n.bindBuffer(n.ARRAY_BUFFER,this.quadBuffer),n.enableVertexAttribArray(this.aPosLocEc),n.vertexAttribPointer(this.aPosLocEc,2,n.FLOAT,!1,0,0),n.activeTexture(n.TEXTURE0),n.bindTexture(n.TEXTURE_2D,e),n.uniform1i(this.uEc.uTexture,0),n.uniform2f(this.uEc.uSrcOffset,r,t),n.uniform2f(this.uEc.uSrcSize,this.fboW,this.fboH),n.uniform2f(this.uEc.uDstSize,i,l),n.drawArrays(n.TRIANGLES,0,6),o<.5)return this.backdropCropTex;if(this.useKawaseBlur){let c=ye(o,this.kawaseQuality),u=o*Math.sqrt(6*c/((c+1)*(2*c+1)));this.lastBlurStats={type:"kawase",passes:c,taps:4*c,maxSample:u*Math.SQRT2,w:i,h:l,progMs:0,stateMs:0,drawMs:0},this.ensureKawaseProgram();let h=this.kawasePrograms,f=n.getParameter(n.FRAMEBUFFER_BINDING),b=n.isEnabled(n.SCISSOR_TEST),m=n.getParameter(n.SCISSOR_BOX);n.disable(n.SCISSOR_TEST),n.disable(n.BLEND);let g=this.backdropCropTex;for(let p=0;p<c;p++){let x=p%2===0,v=x?this.elBlurFboA:this.elBlurFboB;n.bindFramebuffer(n.FRAMEBUFFER,v),n.viewport(0,0,i,l),n.useProgram(h.prog),n.bindBuffer(n.ARRAY_BUFFER,this.quadBuffer),n.enableVertexAttribArray(h.aPos),n.vertexAttribPointer(h.aPos,2,n.FLOAT,!1,0,0),n.activeTexture(n.TEXTURE0),n.bindTexture(n.TEXTURE_2D,g),n.uniform1i(h.uTexture,0),n.uniform2f(h.uTexSize,i,l),n.uniform1f(h.uRadius,o),n.uniform1f(h.uIteration,p),n.uniform1f(h.uTotalIters,c),n.drawArrays(n.TRIANGLES,0,6),g=x?this.elBlurFboATex:this.elBlurFboBTex}return n.bindFramebuffer(n.FRAMEBUFFER,f),n.viewport(0,0,this.fboW,this.fboH),b&&(n.enable(n.SCISSOR_TEST),n.scissor(m[0],m[1],m[2],m[3])),(c-1)%2===0?this.elBlurFboATex:this.elBlurFboBTex}let d=Re(o);return d=Math.min(d,Math.max(1,this.blurTapCap|0)),this.lastBlurStats={type:"gauss",passes:2,taps:d,maxSample:3*o,w:i,h:l,progMs:0,stateMs:0,drawMs:0},this.runBlurPasses(this.backdropCropTex,this.elBlurFboA,this.elBlurFboATex,this.elBlurFboB,this.elBlurFboBTex,i,l,o,d,!0)},drawElFboComposite(e,r,t,s,a,o,n,i){let l=this.gl;l.useProgram(this.elFboCompositeProgram),l.bindBuffer(l.ARRAY_BUFFER,this.quadBuffer),l.enableVertexAttribArray(this.aPosLocEf),l.vertexAttribPointer(this.aPosLocEf,2,l.FLOAT,!1,0,0),l.activeTexture(l.TEXTURE0),l.bindTexture(l.TEXTURE_2D,e),l.uniform1i(this.uEf.uTexture,0),l.uniform2f(this.uEf.uCanvasSize,this.fboW,this.fboH),l.uniform2f(this.uEf.uElementCenter,s,a),l.uniform2f(this.uEf.uElementSize,o,n),l.uniform1f(this.uEf.uRotation,i),l.uniform2f(this.uEf.uSrcSize,r,t),l.enable(l.BLEND),l.blendFuncSeparate(l.ONE,l.ONE_MINUS_SRC_ALPHA,l.ONE,l.ONE_MINUS_SRC_ALPHA),l.drawArrays(l.TRIANGLES,0,6)},intersectClipScissor(e,r,t,s,a){let o=e.clipRect;if(!o)return{x:r,y:t,w:s,h:a};let n=Math.round(o.x*this.dpr),i=Math.round((this.cssHeight-(o.y+o.h))*this.dpr),l=Math.round(o.w*this.dpr),d=Math.round(o.h*this.dpr),c=Math.max(r,n),u=Math.max(t,i),h=Math.min(r+s,n+l),f=Math.min(t+a,i+d);return{x:c,y:u,w:Math.max(0,h-c),h:Math.max(0,f-u)}}};var ie=1.4142135623730951,ts=.7853981633974483,ue=.7071067811865476;function gt(e,r,t,s){let a=(3*t/e-r*r/(e*e))/3,o=(2*r*r*r/(e*e*e)-9*r*t/(e*e)+27*s/e)/27,n=o*o/4+a*a*a/27,i=Math.sqrt(n);return Math.cbrt(-o/2+i)+Math.cbrt(-o/2-i)-r/(3*e)}function rs(e,r,t){let s=-e/2,a=-t,o=t*e/2-r*r/8,n=(3*a-s*s)/3,i=(2*s*s*s-9*s*a+27*o)/27,l=Math.sqrt(-n*n*n/27),d=Math.acos(-i/(2*l)),u=2*Math.sqrt(-n/3)*Math.cos(d/3)-s/3,h=Math.sqrt(2*u-e);return(h-Math.sqrt(h*h-4*(u+r/(2*h))))/2}var pt=class{constructor(r=2/3,t=.5){this.extendedFraction=r,this.arcFraction=t,this.theta=(1-t)*ts,this.cos=Math.cos(this.theta),this.sin=Math.sin(this.theta),this.cot=1/Math.tan(this.theta),this.cos2=this.cos*this.cos,this.sin2=this.sin*this.sin,this.cos3=this.cos2*this.cos,this.sin3=this.sin2*this.sin;let s=this.cos,a=this.sin,o=this.cot,n=this.cos2,i=this.sin2,l=this.cos3,d=this.sin3;this.k0=27*(ie-6*s+6*ie*n-4*l)*o+2*a*(-9+2*(ie-2*a)*d+2*ie*s*(9+i)-2*n*(9+2*i)),this.k1=-81*(-2+ie+4*(-1+ie)*s+2*(-2+ie)*n)*o-4*a*(-9+9*ie+ie*d+(-2+ie)*s*(9+i)),this.k2=9*(9*(-4+3*ie+(-6+4*ie)*s)*o+(-6+4*ie)*a),this.k3=27*(10-7*ie)*o}buildEvenCornerBezierPoints(r){let t=this.extendedFraction*r,s=gt(this.k3,this.k2,this.k1+8*-t*this.sin3*this.sin,this.k0),a=ue+(-ue+this.sin)/s,o=1-ue+(ue-this.cos)/s,n=a-o*this.cot,i=n-1.5*s*o*o/this.sin3,l=-t,d=1-o,c=1-a,u=1-n,h=1-i,f=1-l,b=1.5*s,m=this.cos2-this.sin2,g=d-a,T=c-o,p=-(this.cos*T-this.sin*g),x=(-m+Math.sqrt(m*m-4*b*p))/(2*b),v=a+x*this.cos,S=o+x*this.sin,C=d-x*this.sin,M=c-x*this.cos;return[l,0,i,0,n,0,a,o,v,S,C,M,d,c,1,u,1,h,1,f]}buildUnevenCornerBezierPoints(r,t){let s=this.extendedFraction*r,a=this.extendedFraction*t,o=gt(this.k3,this.k2,this.k1+8*-s*this.sin3*this.sin,this.k0),n=gt(this.k3,this.k2,this.k1+8*-a*this.sin3*this.sin,this.k0),i=ue+(-ue+this.sin)/o,l=1-ue+(ue-this.cos)/o,d=i-l*this.cot,c=d-1.5*o*l*l/this.sin3,u=-s,h=ue+(-ue+this.sin)/n,f=1-ue+(ue-this.cos)/n,b=h-f*this.cot,m=b-1.5*n*f*f/this.sin3,g=-a,T=1-f,p=1-h,x=1-b,v=1-m,S=1-g,C=1.5*o,M=1.5*n,L=this.cos2-this.sin2,R=T-i,E=p-l,F=-(this.cos*E-this.sin*R),y=this.sin*E-this.cos*R,U=2*(y/M),w=L*L*L/(C*M*M),W=(C*y*y+F*L*L)/(C*M*M),k=rs(U,w,W),P=(-y-M*k*k)/L,X=i+P*this.cos,$=l+P*this.sin,Y=T-k*this.sin,B=p-k*this.cos;return[u,0,c,0,d,0,i,l,X,$,Y,B,T,p,1,x,1,v,1,S]}getCornerBezierPoints(r,t){let s=r===0?0:r===1?1:-1,a=t===0?0:t===1?1:-1;return s>=0&&a>=0?s===0&&a===0?this.buildEvenCornerBezierPoints(0):s===1&&a===1?this.buildEvenCornerBezierPoints(1):this.buildUnevenCornerBezierPoints(s===1?1:0,a===1?1:0):this.buildUnevenCornerBezierPoints(Math.max(0,Math.min(1,r)),Math.max(0,Math.min(1,t)))}};function Se(e,r,t,s){let a=new pt,o=s,n=Math.max(0,Math.min(1,(r*.5-o)/o)),i=Math.max(0,Math.min(1,(t*.5-o)/o)),l=a.getCornerBezierPoints(n,i);if(l.length<20)return new Path2D;let d=new Path2D,c=r-o,u=0;return d.moveTo(c+l[0]*o,u+l[1]*o),d.bezierCurveTo(c+l[2]*o,u+l[3]*o,c+l[4]*o,u+l[5]*o,c+l[6]*o,u+l[7]*o),d.bezierCurveTo(c+l[8]*o,u+l[9]*o,c+l[10]*o,u+l[11]*o,c+l[12]*o,u+l[13]*o),d.bezierCurveTo(c+l[14]*o,u+l[15]*o,c+l[16]*o,u+l[17]*o,c+l[18]*o,u+l[19]*o),c=r-o,u=t,d.lineTo(c+l[18]*o,u-l[19]*o),d.bezierCurveTo(c+l[16]*o,u-l[17]*o,c+l[14]*o,u-l[15]*o,c+l[12]*o,u-l[13]*o),d.bezierCurveTo(c+l[10]*o,u-l[11]*o,c+l[8]*o,u-l[9]*o,c+l[6]*o,u-l[7]*o),d.bezierCurveTo(c+l[4]*o,u-l[5]*o,c+l[2]*o,u-l[3]*o,c+l[0]*o,u-l[1]*o),c=o,u=t,d.lineTo(c-l[0]*o,u-l[1]*o),d.bezierCurveTo(c-l[2]*o,u-l[3]*o,c-l[4]*o,u-l[5]*o,c-l[6]*o,u-l[7]*o),d.bezierCurveTo(c-l[8]*o,u-l[9]*o,c-l[10]*o,u-l[11]*o,c-l[12]*o,u-l[13]*o),d.bezierCurveTo(c-l[14]*o,u-l[15]*o,c-l[16]*o,u-l[17]*o,c-l[18]*o,u-l[19]*o),c=o,u=0,d.lineTo(c-l[18]*o,u+l[19]*o),d.bezierCurveTo(c-l[16]*o,u+l[17]*o,c-l[14]*o,u+l[15]*o,c-l[12]*o,u+l[13]*o),d.bezierCurveTo(c-l[10]*o,u+l[11]*o,c-l[8]*o,u+l[9]*o,c-l[6]*o,u+l[7]*o),d.bezierCurveTo(c-l[4]*o,u+l[5]*o,c-l[2]*o,u+l[3]*o,c-l[0]*o,u+l[1]*o),d.closePath(),d}var he=new Map,ss=32*1024*1024,bt=0,St=new Uint8Array(128*128),Yt=new Int32Array(128*128),Vt=new Int32Array(128*128),Kt=new Uint8Array(128*128*4),$t=32,xe=[];function jt(){return Array.from(he.entries()).map(([e,r])=>({key:e,tex:r.tex,texSize:r.texSize}))}function Zt(e,r,t,s=1,a=1,o=!1){let i=Math.max(e,r)*(s||1)*2,l=128;for(;l<i&&l<1024;)l<<=1;let d=Math.max(32,Math.ceil(l*a)),c=`${e},${r},${t},${d},s${o?1:0}`,u=he.get(c);if(u)return he.delete(c),he.set(c,u),xe.length>=$t&&xe.shift(),xe.push({timestamp:performance.now(),key:c,w:e,h:r,radius:t,texSize:d,cacheHit:!0,stepCanvasSetup:0,stepPathDraw:0,stepGetImageData:0,stepAlphaExtract:0,stepInitArrays:0,stepForwardPass:0,stepBackwardPass:0,stepPack:0,stepTotal:0}),{tex:u.tex,texSize:d};let h=performance.now(),f=Math.max(e,r),b=e/f,m=r/f,g=document.createElement("canvas");g.width=d,g.height=d;let T=g.getContext("2d",{willReadFrequently:!0});T.clearRect(0,0,d,d);let p=performance.now(),x=4,v=(d-2*x)*b,S=(d-2*x)*m,C=(d-v)/2,M=(d-S)/2,L=v/e,R=t*L,E=Se(T,v,S,R);T.fillStyle="white",T.translate(C,M),T.fill(E),T.translate(-C,-M);let F=performance.now(),y=T.getImageData(0,0,d,d),U=performance.now(),w=d*d;St.length<w&&(St=new Uint8Array(w),Yt=new Int32Array(w),Vt=new Int32Array(w),Kt=new Uint8Array(w*4));let W=St,k=Yt,P=Vt,X=2147483647,$=new Uint32Array(y.data.buffer);for(let A=0;A<w;A++){let _=$[A]>>>24&255;W[A]=_,_>128?(k[A]=0,P[A]=X):(k[A]=X,P[A]=0)}let Y=performance.now(),B=Y,G=B,K=B;if(!o){let A=d;for(let _=0;_<A;_++)for(let V=0;V<A;V++){let q=_*A+V,O=k[q],D=P[q];if(V>0&&_>1){let I=q-A-1-A,H=11,z=k[I]+H;z<O&&(O=z);let N=P[I]+H;N<D&&(D=N)}if(V>0){let I=q-1,H=5,z=k[I]+H;z<O&&(O=z);let N=P[I]+H;N<D&&(D=N)}if(V>0&&_>0){let I=q-A-1,H=7,z=k[I]+H;z<O&&(O=z);let N=P[I]+H;N<D&&(D=N)}if(_>0){let I=q-A,H=5,z=k[I]+H;z<O&&(O=z);let N=P[I]+H;N<D&&(D=N)}if(V<A-1&&_>0){let I=q-A+1,H=7,z=k[I]+H;z<O&&(O=z);let N=P[I]+H;N<D&&(D=N)}if(V<A-2&&_>0){let I=q-A+2,H=11,z=k[I]+H;z<O&&(O=z);let N=P[I]+H;N<D&&(D=N)}k[q]=O,P[q]=D}G=performance.now();for(let _=A-1;_>=0;_--)for(let V=A-1;V>=0;V--){let q=_*A+V,O=k[q],D=P[q];if(V<A-1&&_<A-2){let I=q+A+1+A,H=11,z=k[I]+H;z<O&&(O=z);let N=P[I]+H;N<D&&(D=N)}if(V<A-1){let I=q+1,H=5,z=k[I]+H;z<O&&(O=z);let N=P[I]+H;N<D&&(D=N)}if(V<A-1&&_<A-1){let I=q+A+1,H=7,z=k[I]+H;z<O&&(O=z);let N=P[I]+H;N<D&&(D=N)}if(_<A-1){let I=q+A,H=5,z=k[I]+H;z<O&&(O=z);let N=P[I]+H;N<D&&(D=N)}if(V>0&&_<A-1){let I=q+A-1,H=7,z=k[I]+H;z<O&&(O=z);let N=P[I]+H;N<D&&(D=N)}if(V>1&&_<A-1){let I=q+A-2,H=11,z=k[I]+H;z<O&&(O=z);let N=P[I]+H;N<D&&(D=N)}k[q]=O,P[q]=D}K=performance.now()}let j=R,re=Kt,ne=new Uint32Array(re.buffer),ae=4278190080;if(o)for(let A=0;A<w;A++)ne[A]=ae|W[A];else for(let A=0;A<w;A++){let _=(k[A]-P[A])/5,q=((_/j>1?1:_/j<-1?-1:_/j)*.5+.5)*255+.5|0;ne[A]=ae|q<<8|W[A]}let oe=performance.now(),te=re.slice(0,w*4);for(he.set(c,{tex:te,texSize:d}),bt+=te.byteLength;bt>ss&&he.size>1;){let A=he.keys().next().value;if(A===void 0)break;let _=he.get(A);_&&(bt-=_.tex.byteLength),he.delete(A)}return xe.length>=$t&&xe.shift(),xe.push({timestamp:oe,key:c,w:e,h:r,radius:t,texSize:d,cacheHit:!1,stepCanvasSetup:p-h,stepPathDraw:F-p,stepGetImageData:U-F,stepAlphaExtract:Y-U,stepInitArrays:0,stepForwardPass:G-B,stepBackwardPass:K-G,stepPack:oe-K,stepTotal:oe-h}),{tex:re,texSize:d}}var Qt={async loadWallpaper(e){this.wallpaperSrc=e;let r=new Image;r.crossOrigin="anonymous",await new Promise((i,l)=>{r.onload=()=>i(),r.onerror=()=>l(new Error("Failed to load wallpaper: "+e)),r.src=e});let t=this.gl;this.wallpaperTexture&&t.deleteTexture(this.wallpaperTexture);let s=t.createTexture();t.bindTexture(t.TEXTURE_2D,s),t.pixelStorei(t.UNPACK_FLIP_Y_WEBGL,!1),t.texImage2D(t.TEXTURE_2D,0,t.RGBA,t.RGBA,t.UNSIGNED_BYTE,r);let a=r.naturalWidth,o=r.naturalHeight;(a&a-1)===0&&(o&o-1)===0?(t.generateMipmap(t.TEXTURE_2D),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR_MIPMAP_LINEAR)):t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),this.wallpaperTexture=s,this.wallpaperSize=[a||1,o||1],this.wallpaperReady=!0,this.clearBackdropBlurCache(),this.wallpaperVersion++,this.markAllDirty(),this.requestRender()},async loadSdfTexture(e){this.sdfSrc=e;let r=new Image;r.crossOrigin="anonymous",await new Promise((a,o)=>{r.onload=()=>a(),r.onerror=()=>o(new Error("Failed to load SDF texture: "+e)),r.src=e});let t=this.gl;this.sdfTexture&&t.deleteTexture(this.sdfTexture);let s=t.createTexture();t.bindTexture(t.TEXTURE_2D,s),t.pixelStorei(t.UNPACK_FLIP_Y_WEBGL,!1),t.texImage2D(t.TEXTURE_2D,0,t.RGBA,t.RGBA,t.UNSIGNED_BYTE,r),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),this.sdfTexture=s,this.sdfTextureSize=[r.naturalWidth||1,r.naturalHeight||1],this.sdfTextureReady=!0,this.markAllDirty(),this.requestRender()},loadSdfTextureFromData(e,r,t){this.loadTextSdfTextureFromData(e,r,t)},loadTextSdfTextureFromData(e,r,t){if(r<1||t<1)return;this.textSdfPixels={data:e,w:r,h:t};let s=this.gl;this.textSdfTexture&&s.deleteTexture(this.textSdfTexture);let a=s.createTexture();s.bindTexture(s.TEXTURE_2D,a),s.pixelStorei(s.UNPACK_FLIP_Y_WEBGL,!1),s.texImage2D(s.TEXTURE_2D,0,s.RGBA,r,t,0,s.RGBA,s.UNSIGNED_BYTE,e),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MIN_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MAG_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_S,s.CLAMP_TO_EDGE),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_T,s.CLAMP_TO_EDGE),this.textSdfTexture=a,this.textSdfTextureSize=[r,t],this.textSdfTextureReady=!0,this.markAllDirty(),this.requestRender()},loadContinuousSdf(e,r,t){let s=this.debugSdfHoleTopLeftR,a=this.debugSdfHoleTopLeftG,o=!!this.noContinuousSdf,n=this.capsuleSdfQuality,i=`${e},${r},${t},${this.dpr},q${n},s${o?1:0},r${s?1:0},g${a?1:0}`,l=this.continuousSdfPool.get(i);if(l)this._lastCapsuleUploadMs=0,this._lastCapsuleGenMs=0,this._lastCapsuleKey=i+" (pool hit)";else{let d=performance.now(),{tex:c,texSize:u}=Zt(e,r,t,this.dpr,this.capsuleSdfQuality,o),h=performance.now(),f=this.gl,b=f.createTexture();f.bindTexture(f.TEXTURE_2D,b),f.pixelStorei(f.UNPACK_FLIP_Y_WEBGL,!0);let m=c;if(s||a){m=c.slice();let p=u>>1;for(let x=0;x<p;x++){let v=x*u*4;for(let S=0;S<p;S++){let C=v+S*4;s&&(m[C]=0),a&&(m[C+1]=0)}}}let g=performance.now();f.texImage2D(f.TEXTURE_2D,0,f.RGBA,u,u,0,f.RGBA,f.UNSIGNED_BYTE,m),f.finish();let T=performance.now();if((s||a)&&this._debugUploadedSdfTexMap.set(i,{tex:m.slice(),texSize:u}),f.texParameteri(f.TEXTURE_2D,f.TEXTURE_MIN_FILTER,f.LINEAR),f.texParameteri(f.TEXTURE_2D,f.TEXTURE_MAG_FILTER,f.LINEAR),f.texParameteri(f.TEXTURE_2D,f.TEXTURE_WRAP_S,f.CLAMP_TO_EDGE),f.texParameteri(f.TEXTURE_2D,f.TEXTURE_WRAP_T,f.CLAMP_TO_EDGE),l={tex:b,texSize:u},this.continuousSdfPool.set(i,l),this._lastCapsuleUploadMs=T-g,this._lastCapsuleGenMs=h-d,this._lastCapsuleKey=i,this.continuousSdfPool.size>16){let p=this.continuousSdfPool.keys().next().value;if(p){let x=this.continuousSdfPool.get(p);x&&f.deleteTexture(x.tex),this.continuousSdfPool.delete(p)}}}this.continuousSdfTexture=l.tex,this.continuousSdfTexSize=[l.texSize,l.texSize],this.continuousSdfKey=i},resize(e,r){this.dpr<=0&&(this.dpr=Math.min(window.devicePixelRatio||1,3));let t=Math.round(e*this.dpr),s=Math.round(r*this.dpr);(this.canvas.width!==t||this.canvas.height!==s)&&(this.canvas.width=t,this.canvas.height=s,this.gl.viewport(0,0,t,s),this.resizeFBOs(t,s));for(let a of this.buttonConfigs)this.fgDirtyIds.add(a.id);if(this.cssWidth=e,this.cssHeight=r,this.elFboCache.size>0){let a=this.gl;for(let o of this.elFboCache.values())a.deleteFramebuffer(o.fb),a.deleteTexture(o.tex);this.elFboCache.clear()}this.markAllDirty(),this.requestRender()}};var Jt={setContentHeight(e){this.contentHeight=e,this.clampScrollY(),this.requestRender()},setScrollY(e){this.scrollVelocity=0,this.scrollY=this.clampScrollValue(e),this.requestRender()},setScrollVelocity(e){this.scrollVelocity=Math.max(-4e3,Math.min(4e3,e)),this.startAnimation()},getScrollY(){return this.scrollY},getScrollVelocity(){return this.scrollVelocity},clampScrollValue(e){let r=Math.max(0,this.contentHeight-this.cssHeight);return e<0?0:e>r?r:e},clampScrollY(){this.scrollY=this.clampScrollValue(this.scrollY)},setBackgroundColor(e){this.backgroundColor!==e&&(this.backgroundColor&&e&&this.backgroundColor[0]===e[0]&&this.backgroundColor[1]===e[1]&&this.backgroundColor[2]===e[2]||(this.backgroundColor=e,this.markAllDirty(),this.requestRender()))},setGravityAngle(e){Math.abs(this.gravityAngle-e)<.02||(this.gravityAngle=e,this.markGravityDirty(),this.requestRender())}};var Oe=class{constructor(){this.samples=[]}resetTracking(){this.samples.length=0}addPosition(r,t){this.samples.push({t:r,p:t}),this.samples.length>20&&this.samples.shift()}calculateVelocity(r=100){let t=this.samples;if(t.length<2)return 0;let s=t[t.length-1].t,a=s-r,o=0,n=0,i=0,l=0,d=0;for(let h=t.length-1;h>=0;h--){let f=t[h];if(f.t<a)break;let b=(f.t-s)/1e3;n+=b,i+=f.p,l+=b*b,d+=b*f.p,o++}if(o<2)return 0;let c=o*l-n*n;return Math.abs(c)<1e-9?0:(o*d-n*i)/c}};var er={ensureToggleState(e,r,t=1.5,s=1){let a=this.toggleStates.get(e);return a?(t!==1.5&&(a.pressedScale=t),s!==1&&(a.valueRangeSpan=s)):(a={fraction:r,fractionVelocity:0,targetFraction:r,pressProgress:0,pressVelocity:0,targetPress:0,scaleX:1,scaleXVelocity:0,targetScaleX:1,scaleY:1,scaleYVelocity:0,targetScaleY:1,velocity:0,velocityVelocity:0,targetVelocity:0,isDragging:!1,trackVelocityAfterRelease:!1,velocityTracker:new Oe,lastFractionForVelocity:r,lastFractionTime:0,pressedScale:t,valueRangeSpan:s,panelOffset:0,panelOffsetVelocity:0,targetPanelOffset:0},this.toggleStates.set(e,a)),a},setToggleTarget(e,r){let t=this.ensureToggleState(e,r);t.isDragging||t.targetFraction!==r&&(t.targetFraction=r,t.trackVelocityAfterRelease=!1,t.targetVelocity=0,t.velocity=0,t.velocityVelocity=0,t.velocityTracker.resetTracking(),t.targetPress===0&&(t.targetPress=1,t.targetScaleX=t.pressedScale,t.targetScaleY=t.pressedScale),this.markGroupDirty(e),this.startAnimation())},beginToggleDrag(e,r){let t=this.ensureToggleState(e,r);t.isDragging=!0,t.targetPress=1,t.targetScaleX=t.pressedScale,t.targetScaleY=t.pressedScale,t.velocityTracker.resetTracking(),t.targetVelocity=0,t.velocity=0,t.velocityVelocity=0,this.markGroupDirty(e),this.startAnimation()},dragToggle(e,r,t,s,a){let o=this.ensureToggleState(e,r);if(!o.isDragging)return;let n=(t-s)/Math.max(1,a),i=Math.max(0,Math.min(1,r+n));o.targetFraction=i,this.markGroupDirty(e),this.startAnimation()},endToggleDrag(e){let r=this.toggleStates.get(e);if(!r)return 0;r.isDragging=!1;let t=r.targetFraction>=.5?1:0;return r.targetFraction=t,r.trackVelocityAfterRelease=!0,this.markGroupDirty(e),this.startAnimation(),t},endSliderDrag(e){let r=this.toggleStates.get(e);if(!r)return 0;r.isDragging=!1;let t=r.targetFraction;return r.trackVelocityAfterRelease=!0,this.markGroupDirty(e),this.startAnimation(),t},getToggleFraction(e){return this.toggleStates.get(e)?.fraction??0},setSliderDragPosition(e,r){let t=this.toggleStates.get(e);if(!t)return;let s=Math.max(0,Math.min(1,r));t.targetFraction!==s&&(t.targetFraction=s,this.markGroupDirty(e),this.startAnimation())},getToggleTarget(e){return this.toggleStates.get(e)?.targetFraction??0}};var Ae=Math.sqrt(300),Te=Ae*Math.sqrt(1-.5*.5),Q=.003,as=1e3,xt=Math.sqrt(as),os=250,De=.6,Tt=Math.sqrt(os),na=Tt*Math.sqrt(1-De*De),is=250,Ie=.7,vt=Math.sqrt(is),la=vt*Math.sqrt(1-Ie*Ie),ns=300,He=.5,Ct=Math.sqrt(ns),ua=Ct*Math.sqrt(1-He*He);function we(e,r,t,s){let a=e-t,o=r,n=Math.exp(-.5*Ae*s),i=Math.cos(Te*s),l=Math.sin(Te*s),d=a*n*i+(o+.5*Ae*a)/Te*n*l,c=(o+.5*Ae*a)/Te,u=-.5*Ae*d+n*(-a*Te*l+c*Te*i);return{current:t+d,velocity:u}}function ze(e,r,t,s,a){let o=e-t,n=r,i=Math.exp(-a*s),l=o*i+(n+a*o)*s*i,d=-a*o*i+(n+a*o)*(i-a*s*i);return{current:t+l,velocity:d}}function Ue(e,r,t,s,a,o){let n=e-t,i=r,l=a*Math.sqrt(1-o*o),d=Math.exp(-o*a*s),c=Math.cos(l*s),u=Math.sin(l*s),h=n*d*c+(i+o*a*n)/l*d*u,f=(i+o*a*n)/l,b=-o*a*h+d*(-n*l*u+f*l*c);return{current:t+h,velocity:b}}var tr={setTabSelected(e,r,t){let s=this.ensureToggleState(e,r,ce.TAB_PRESSED_SCALE,t-1);s.isDragging||s.targetFraction!==r&&(s.targetFraction=r,s.trackVelocityAfterRelease=!1,s.targetVelocity=0,s.velocity=0,s.velocityVelocity=0,s.velocityTracker.resetTracking(),s.targetPress===0&&(s.targetPress=1,s.targetScaleX=s.pressedScale,s.targetScaleY=s.pressedScale),this.markGroupDirty(e),this.startAnimation())},beginTabDrag(e,r,t){let s=this.ensureToggleState(e,r,ce.TAB_PRESSED_SCALE,t-1);s.isDragging=!0,s.targetPress=1,s.targetScaleX=s.pressedScale,s.targetScaleY=s.pressedScale,s.velocityTracker.resetTracking(),s.targetVelocity=0,s.velocity=0,s.velocityVelocity=0,this.markGroupDirty(e),this.startAnimation()},dragTab(e,r,t,s,a,o){let n=this.ensureToggleState(e,r,ce.TAB_PRESSED_SCALE,o-1);if(!n.isDragging)return;let i=(t-s)/Math.max(1,a),l=Math.max(0,Math.min(o-1,r+i));n.targetFraction=l;let d=a*o,c=Math.max(-1,Math.min(1,(t-s)/Math.max(1,d))),u=1-Math.pow(1-Math.abs(c),2);n.targetPanelOffset=4*1*Math.sign(c)*u,this.markGroupDirty(e),this.startAnimation()},endTabDrag(e,r){let t=this.toggleStates.get(e);if(!t)return 0;t.isDragging=!1;let s=Math.round(t.targetFraction),a=Math.max(0,Math.min(r-1,s));return t.targetFraction=a,t.velocityTracker.resetTracking(),t.trackVelocityAfterRelease=!1,t.targetVelocity=0,t.targetPanelOffset=0,this.markGroupDirty(e),this.startAnimation(),a},getTabFraction(e){return this.toggleStates.get(e)?.fraction??0},getTabTarget(e){return this.toggleStates.get(e)?.targetFraction??0}};function rr(e){return JSON.stringify([e.rect.w,e.rect.h,e.cornerRadius,e.blurRadius,e.useSeparableBlur,e.scrimColor,e.surfaceColor,e.tintColor,e.independentBackdrop,e.sampleWallpaper,e.chromaticAberration,e.outerShadow,e.highlight,e.isMagnifier,e.isSdfTexture,e.enterProgress,e.enterSafeProgress,e.enterStretchFactor,e.elementAlpha,e.useGravityAngle,e.elementRotation,e.backdropFbo,e.brightness,e.contrast,e.saturation,e.useContinuousSdf,e.isToggleKnob,e.isToggleTrack,e.isSliderFill,e.isBottomTabContainer,e.isBottomTabContent,e.isBottomTabIndicator,e.sceneBlurRadius,e.refractionHeight,e.refractionAmount,e.depthEffect])}var sr={setElements(e){this.setButtons(e)},setButtons(e){let r=new Set(this.buttonConfigs.map(n=>n.id)),t=new Set(e.map(n=>n.id));for(let n of t)r.has(n)||this.fgDirtyIds.add(n);for(let n of e){let i=this.buttonConfigs.find(p=>p.id===n.id);if(!i)continue;let l=(p,x)=>{if(!p||!x)return p===x;if(p.length!==x.length)return!1;for(let v=0;v<p.length;v++)if(p[v]!==x[v])return!1;return!0},d=i.text?.icon,c=n.text?.icon,u=!!d!=!!c||d&&c&&(d.path!==c.path||d.size!==c.size||!l(d.color,c.color)),h=i.icon,f=n.icon,b=!!h!=!!f||h&&f&&(h.path!==f.path||h.size!==f.size||!l(h.color,f.color)),m=i.text,g=n.text,T=!!m!=!!g||m&&g&&(!l(m.color,g.color)||m.halo!==g.halo||m.fontSizePx!==g.fontSizePx||m.fontWeight!==g.fontWeight||m.align!==g.align||m.wrap!==g.wrap||m.paddingPx!==g.paddingPx||m.valign!==g.valign||m.maxLines!==g.maxLines);(i.label!==n.label||!l(i.labelColor,n.labelColor)||i.showChevron!==n.showChevron||i.rect.w!==n.rect.w||i.rect.h!==n.rect.h||n.text&&i.text&&i.text.content!==n.text.content||n.text&&!i.text||!n.text&&i.text||u||b||T)&&this.fgDirtyIds.add(n.id)}for(let n of r)if(!t.has(n)){this.buttonStates.delete(n);let i=this.fgTextures.get(n);i&&(this.gl.deleteTexture(i),this.fgTextures.delete(n)),this.fgDirtyIds.delete(n),this.deleteElFboCacheEntry(n)}for(let n of e)this.buttonStates.has(n.id)||this.buttonStates.set(n.id,{pressProgress:0,pressVelocity:0,targetPress:0,dragX:0,dragY:0,dragVx:0,dragVy:0,targetDragX:0,targetDragY:0,startDragX:0,startDragY:0,interactiveValue:0,interactiveVelocity:0,targetInteractiveValue:0});let s=new Map;for(let n of this.buttonConfigs)s.set(n.id,rr(n));for(let n of e){let i=s.get(n.id);i!==void 0&&i!==rr(n)&&this.markElementDirty(n.id)}let a=this.buttonConfigs.some(n=>n.isBottomTabIndicator),o=e.some(n=>n.isBottomTabIndicator);!a&&o&&(this.pendingExtraRenders=1),this.buttonConfigs=e,this.requestRender()},setInteractiveValue(e,r){let t=this.buttonStates.get(e);t&&t.targetInteractiveValue!==r&&(t.targetInteractiveValue=r,this.markElementDirty(e),this.startAnimation(),this.requestRender())},setPressed(e,r,t){let s=this.buttonStates.get(e);if(s){if(r){let a=this.buttonConfigs.find(o=>o.id===e);if(a&&t){let o=t.x-a.rect.x,n=t.y-a.rect.y;s.targetPress===0&&(s.startDragX=o,s.startDragY=n,s.dragX=o,s.dragY=n,s.dragVx=0,s.dragVy=0),s.dragX=o,s.dragY=n,s.dragVx=0,s.dragVy=0,s.targetDragX=o,s.targetDragY=n}s.targetPress=1}else s.targetPress=0,s.targetDragX=s.startDragX,s.targetDragY=s.startDragY;this.markElementDirty(e),this.startAnimation()}},setDragPosition(e,r){let t=this.buttonStates.get(e);if(!t||t.targetPress===0)return;let s=this.buttonConfigs.find(n=>n.id===e);if(!s)return;let a=r.x-s.rect.x,o=r.y-s.rect.y;t.dragX=a,t.dragY=o,t.dragVx=0,t.dragVy=0,t.targetDragX=a,t.targetDragY=o,this.markElementDirty(e),this.requestRender()}};var ar={startAnimation(){if(this.animRafId!==null)return;let e=performance.now(),r=()=>{let t=performance.now(),s=Math.min((t-e)/1e3,.05);e=t;let a=this.reduceMotion,o=!1;for(let[n,i]of this.buttonStates.entries()){let l=!1,d=Math.abs(i.targetPress-i.pressProgress);if(!a&&(d>Q||Math.abs(i.pressVelocity)>Q)){let u=we(i.pressProgress,i.pressVelocity,i.targetPress,s);i.pressProgress=u.current,i.pressVelocity=u.velocity,o=!0,l=!0}else i.pressProgress=i.targetPress,i.pressVelocity=0;if(!a&&(Math.abs(i.targetDragX-i.dragX)>Q||Math.abs(i.dragVx)>Q)){let u=we(i.dragX,i.dragVx,i.targetDragX,s);i.dragX=u.current,i.dragVx=u.velocity,o=!0,l=!0}else i.dragX=i.targetDragX,i.dragVx=0;if(!a&&(Math.abs(i.targetDragY-i.dragY)>Q||Math.abs(i.dragVy)>Q)){let u=we(i.dragY,i.dragVy,i.targetDragY,s);i.dragY=u.current,i.dragVy=u.velocity,o=!0,l=!0}else i.dragY=i.targetDragY,i.dragVy=0;let c=Math.abs(i.targetInteractiveValue-i.interactiveValue);if(!a&&(c>Q||Math.abs(i.interactiveVelocity)>Q)){let u=we(i.interactiveValue,i.interactiveVelocity,i.targetInteractiveValue,s);i.interactiveValue=u.current,i.interactiveVelocity=u.velocity,o=!0,l=!0}else i.interactiveValue=i.targetInteractiveValue,i.interactiveVelocity=0;l&&this.markElementDirty(n)}for(let[n,i]of this.toggleStates){let l=!1;i.targetPress===1&&!i.isDragging&&Math.abs(i.targetFraction-i.fraction)<.02&&(i.targetPress=0,i.targetScaleX=1,i.targetScaleY=1,l=!0,this.startAnimation());let d=Math.abs(i.targetFraction-i.fraction);if(!a&&(d>Q||Math.abs(i.fractionVelocity)>Q)){let m=ze(i.fraction,i.fractionVelocity,i.targetFraction,s,xt);if(i.fraction=m.current,i.fractionVelocity=m.velocity,i.trackVelocityAfterRelease||i.isDragging){let g=performance.now();i.velocityTracker.addPosition(g,i.fraction);let T=i.velocityTracker.calculateVelocity(),p=i.valueRangeSpan||1;i.targetVelocity=T/p}o=!0,l=!0}else i.fraction=i.targetFraction,i.fractionVelocity=0,i.isDragging||(i.targetVelocity=0,i.trackVelocityAfterRelease=!1,i.velocityTracker.resetTracking());let c=Math.abs(i.targetPress-i.pressProgress);if(!a&&(c>Q||Math.abs(i.pressVelocity)>Q)){let m=ze(i.pressProgress,i.pressVelocity,i.targetPress,s,xt);i.pressProgress=m.current,i.pressVelocity=m.velocity,o=!0,l=!0}else i.pressProgress=i.targetPress,i.pressVelocity=0;let u=Math.abs(i.targetScaleX-i.scaleX);if(!a&&(u>Q||Math.abs(i.scaleXVelocity)>Q)){let m=Ue(i.scaleX,i.scaleXVelocity,i.targetScaleX,s,Tt,De);i.scaleX=m.current,i.scaleXVelocity=m.velocity,o=!0,l=!0}else i.scaleX=i.targetScaleX,i.scaleXVelocity=0;let h=Math.abs(i.targetScaleY-i.scaleY);if(!a&&(h>Q||Math.abs(i.scaleYVelocity)>Q)){let m=Ue(i.scaleY,i.scaleYVelocity,i.targetScaleY,s,vt,Ie);i.scaleY=m.current,i.scaleYVelocity=m.velocity,o=!0,l=!0}else i.scaleY=i.targetScaleY,i.scaleYVelocity=0;let f=Math.abs(i.targetVelocity-i.velocity);if(!a&&(f>Q||Math.abs(i.velocityVelocity)>Q)){let m=Ue(i.velocity,i.velocityVelocity,i.targetVelocity,s,Ct,He);i.velocity=m.current,i.velocityVelocity=m.velocity,o=!0,l=!0}else i.velocity=i.targetVelocity,i.velocityVelocity=0;let b=Math.abs(i.targetPanelOffset-i.panelOffset);if(!a&&(b>Q||Math.abs(i.panelOffsetVelocity)>Q)){let m=ze(i.panelOffset,i.panelOffsetVelocity,i.targetPanelOffset,s,Math.sqrt(300));i.panelOffset=m.current,i.panelOffsetVelocity=m.velocity,o=!0,l=!0}else i.panelOffset=i.targetPanelOffset,i.panelOffsetVelocity=0;l&&this.markGroupDirty(n)}if(!a&&Math.abs(this.scrollVelocity)>.5){let i=this.scrollY+this.scrollVelocity*s,l=this.clampScrollValue(i);l!==i?(this.scrollY=l,this.scrollVelocity=0):(this.scrollY=l,this.scrollVelocity*=Math.exp(-4*s)),o=!0}else this.scrollVelocity=0;o?(this.requestRender(),this.animRafId=requestAnimationFrame(r)):(this.requestRender(),this.animRafId=null)};this.animRafId=requestAnimationFrame(r)},requestRender(){this.contextLost||(this.needsRedraw=!0,this.rafId===null&&(this.rafId=requestAnimationFrame(()=>{this.rafId=null,this.render()})))}};var or={rasterizeForeground(e){if(e.kind==="text"&&e.text){this.rasterizeText(e);return}if(e.kind!=="button"&&!e.label&&!e.icon){this.fgDirtyIds.delete(e.id);return}let r=this.dpr,t=Math.max(1,Math.round(e.rect.w*r)),s=Math.max(1,Math.round(e.rect.h*r));this.fgCanvas.width!==t&&(this.fgCanvas.width=t),this.fgCanvas.height!==s&&(this.fgCanvas.height=s);let a=this.fgCtx;a.setTransform(1,0,0,1,0,0),a.clearRect(0,0,t,s),a.scale(r,r);let o=e.rect.w,n=e.rect.h;if(e.icon){let u=e.icon.size,h=e.icon.color;a.save(),a.translate(o/2-u/2,n/2-u/2);let f=e.icon.viewport??24;a.scale(u/f,u/f);let b=new Path2D(e.icon.path);a.fillStyle=`rgba(${Math.round(h[0]*255)}, ${Math.round(h[1]*255)}, ${Math.round(h[2]*255)}, ${h[3]})`,a.fill(b),a.restore(),this.uploadForegroundTexture(e.id),this.fgDirtyIds.delete(e.id);return}let i=e.labelFontSizePx??n*(15/48),l='-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';a.font=`400 ${i}px ${l}`,a.textBaseline="middle",a.textAlign="center";let d=`rgba(${Math.round(e.labelColor[0]*255)}, ${Math.round(e.labelColor[1]*255)}, ${Math.round(e.labelColor[2]*255)}, ${e.labelColor[3]})`,c=e.labelColor[0]+e.labelColor[1]+e.labelColor[2]<1.5;if(a.save(),a.shadowColor=c?"rgba(255,255,255,0.45)":"rgba(0,0,0,0.15)",a.shadowBlur=c?i*.12:i*.05,a.fillStyle=d,a.fillText(e.label,o/2,n/2+.5),a.restore(),e.showChevron){let u=i*.93,h=a.measureText(e.label).width,f=o/2+h/2+i*.53+u/2,b=n/2;a.save(),a.strokeStyle=d,a.globalAlpha=.6,a.lineWidth=i*.107,a.lineCap="round",a.lineJoin="round",a.beginPath(),a.moveTo(f-u*.3,b-u*.4),a.lineTo(f+u*.2,b),a.lineTo(f-u*.3,b+u*.4),a.stroke(),a.restore()}this.uploadForegroundTexture(e.id),this.fgDirtyIds.delete(e.id)},rasterizeText(e){if(!e.text)return;let r=this.dpr,t=Math.max(1,Math.round(e.rect.w*r)),s=Math.max(1,Math.round(e.rect.h*r));this.fgCanvas.width!==t&&(this.fgCanvas.width=t),this.fgCanvas.height!==s&&(this.fgCanvas.height=s);let a=this.fgCtx;a.setTransform(1,0,0,1,0,0),a.clearRect(0,0,t,s),a.scale(r,r);let o=e.text,n=e.rect.w,i=e.rect.h,l='-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';a.font=`${o.fontWeight} ${o.fontSizePx}px ${l}`,a.textBaseline="middle";let d=o.paddingPx??0,c="none";o.halo==="light"?c="light":o.halo==="dark"?c="dark":(o.halo==="auto"||o.halo===void 0)&&(c=o.color[0]+o.color[1]+o.color[2]<1.5?"light":"dark"),c==="light"?(a.shadowColor="rgba(255,255,255,0.55)",a.shadowBlur=o.fontSizePx*.16):c==="dark"?(a.shadowColor="rgba(0,0,0,0.28)",a.shadowBlur=o.fontSizePx*.1):(a.shadowColor="transparent",a.shadowBlur=0);let u=`rgba(${Math.round(o.color[0]*255)}, ${Math.round(o.color[1]*255)}, ${Math.round(o.color[2]*255)}, ${o.color[3]})`;a.fillStyle=u;let h=0;if(o.icon){let f=o.icon.size,b=o.icon.layoutSize??f,m=o.content?2:0,g=b+m+(o.content?o.fontSizePx:0),T=i/2-g/2,p=n/2,x=T+b/2;a.save(),a.translate(p-f/2,x-f/2);let v=o.icon.viewport??24;a.scale(f/v,f/v);let S=new Path2D(o.icon.path),C=o.icon.color;a.fillStyle=`rgba(${Math.round(C[0]*255)}, ${Math.round(C[1]*255)}, ${Math.round(C[2]*255)}, ${C[3]})`,a.fill(S),a.restore(),h=(b+m)/2}if(o.align==="center")if(a.textAlign="center",o.wrap){let f=mt(a,o.content,n-d*2);o.maxLines!=null&&f.length>o.maxLines&&(f=f.slice(0,o.maxLines));let b=o.fontSizePx*1.35,m=b*f.length,g;o.valign==="top"?g=b/2+h:o.valign==="bottom"?g=i-m+b/2+h:g=i/2-m/2+b/2+h;for(let T of f)a.fillText(T,n/2,g),g+=b}else a.fillText(o.content,n/2,i/2+.5+h);else if(o.align==="left")if(a.textAlign="left",o.wrap){let f=mt(a,o.content,n-d*2);o.maxLines!=null&&f.length>o.maxLines&&(f=f.slice(0,o.maxLines));let b=o.fontSizePx*1.35,m=b*f.length,g;o.valign==="top"?g=b/2+h:o.valign==="bottom"?g=i-m+b/2+h:g=i/2-m/2+b/2+h;for(let T of f)a.fillText(T,d,g),g+=b}else a.fillText(o.content,d,i/2+.5+h);else a.textAlign="right",a.fillText(o.content,n-d,i/2+.5+h);this.uploadForegroundTexture(e.id),this.fgDirtyIds.delete(e.id)},uploadForegroundTexture(e){let r=this.gl,t=this.fgTextures.get(e);t||(t=r.createTexture(),this.fgTextures.set(e,t)),r.bindTexture(r.TEXTURE_2D,t),r.pixelStorei(r.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!0),r.pixelStorei(r.UNPACK_FLIP_Y_WEBGL,!1),r.texImage2D(r.TEXTURE_2D,0,r.RGBA,r.RGBA,r.UNSIGNED_BYTE,this.fgCanvas),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_MIN_FILTER,r.LINEAR),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_MAG_FILTER,r.LINEAR),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_WRAP_S,r.CLAMP_TO_EDGE),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_WRAP_T,r.CLAMP_TO_EDGE),r.pixelStorei(r.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!1)}};function Fe(e,r,t){if(!e.outerShadow||e.outerShadow.radius<=.5||!t.outerShadow)return 3;let a=e.outerShadow.radius,o=Math.max(Math.abs(e.outerShadow.offsetX),Math.abs(e.outerShadow.offsetY)),n=(a+o)*r;return Math.max(3,n+2)}function de(e,r,t,s,a,o=0){let n=e.isToggleKnob||e.isBottomTabIndicator?Math.max(0,Math.min(1,o)):1,i=(e.blurRadius||0)*n,l=0;e.outerShadow&&e.outerShadow.alpha*n>=.15&&(l=(e.outerShadow.radius+Math.max(Math.abs(e.outerShadow.offsetX),Math.abs(e.outerShadow.offsetY)))*n),e.isToggleKnob&&(i=8*(1-n));let d=Math.max(i,l,3)+4,c=r-d,u=t-d,h=s+2*d,f=a+2*d,b=e.elementRotation??0;if(Math.abs(b)>.001){let m=r+s/2,g=t+a/2,T=Math.abs(Math.cos(b)),p=Math.abs(Math.sin(b)),x=h*T+f*p,v=h*p+f*T;c=m-x/2,u=g-v/2,h=x,f=v}return{x:c,y:u,w:h,h:f}}function Et(e,r,t,s,a,o,n,i){if(!e.outerShadow||e.outerShadow.radius<=.5||!i.outerShadow)return null;let l=e.outerShadow.radius,d=e.outerShadow.offsetX,c=e.outerShadow.offsetY,u=Math.max(0,l-d)*o,h=Math.max(0,l+d)*o,f=Math.max(0,l-c)*n,b=Math.max(0,l+c)*n;return{x:r-u,y:t-f,w:s+u+h,h:a+f+b}}function Rt(e,r){return e.x<r.x+r.w&&e.x+e.w>r.x&&e.y<r.y+r.h&&e.y+e.h>r.y}function ir(e,r,t){let s=e.kind==="button",a=r?.pressProgress??0,o=4/48,n=1,i=0,l=0,d=1,c=1;if(e.enterProgress!=null){let R=e.enterProgress,E=R<0?(1-Math.exp(-Math.abs(R)))*-1:R<=1?R:1+(1-Math.exp(-(R-1)));l+=-48*1*(1-E),e.enterStretchFactor!=null&&E>1&&(l+=e.enterStretchFactor*(E-1)*32*1);let F=1+.1*Math.max(0,E-1);d/=F,c*=F}if(s&&e.isInteractive&&r){let R=e.rect.w,E=e.rect.h,F=Math.max(R,E),U=Math.min(R,E),w=.05,W=o;n=1+o*a;let k=r.dragX-r.startDragX,P=r.dragY-r.startDragY;i=U*Math.tanh(w*k/U),l=U*Math.tanh(w*P/U);let X=Math.atan2(P,k),$=Math.min(R/E,1),Y=Math.min(E/R,1);d=n+W*Math.abs(Math.cos(X)*k/F)*$,c=n+W*Math.abs(Math.sin(X)*P/F)*Y}else e.enterProgress==null&&(d=n,c=n);let u=0,h=1,f=1,b=0;if(e.isToggleKnob){let R=this.toggleStates.get(e.isToggleKnob.groupId);if(R){u=R.fraction*e.isToggleKnob.dragWidth,h=R.scaleX,f=R.scaleY,b=R.pressProgress;let E=e.isToggleKnob.velocityDivisor??50,F=R.velocity/E,y=Math.max(-.2,Math.min(.2,F*.75)),U=Math.max(-.2,Math.min(.2,F*.25));h=h/(1-y),f=f*(1-U)}}if(d*=h,c*=f,e.isBottomTabContainer){let R=this.toggleStates.get(e.isBottomTabContainer.groupId);if(R){let E=1+16*1/e.rect.w*R.pressProgress;d*=E,c*=E,i+=R.panelOffset,b=R.pressProgress}}if(e.isBottomTabContent){let R=this.toggleStates.get(e.isBottomTabContent.groupId);if(R){let E=e.isBottomTabContent.containerWidth??e.rect.w,F=1+16*1/E*R.pressProgress;d*=F;let y=1+.2*R.pressProgress;d*=y,c*=F*y,i+=R.panelOffset}}if(e.isBottomTabIndicator){let R=this.toggleStates.get(e.isBottomTabIndicator.groupId);if(R){u+=R.fraction*e.isBottomTabIndicator.dragWidth,u+=R.panelOffset;let E=R.scaleX,F=R.scaleY,y=R.velocity/10,U=Math.max(-.2,Math.min(.2,y*.75)),w=Math.max(-.2,Math.min(.2,y*.25)),W=E/(1-U),k=F*(1-w);d*=W,c*=k,b=Math.max(b,R.pressProgress)}}e.elementScaleX!=null&&(d*=e.elementScaleX),e.elementScaleY!=null&&(c*=e.elementScaleY);let m=t.x+e.rect.w/2+i+u,g=t.y+e.rect.h/2+l,T=e.rect.w*d,p=e.rect.h*c,x=m-T/2,v=g-p/2,S=e.cornerRadius*Math.min(d,c),C=[S,S,S,S],L=!!((e.independentBackdrop||e.directBackdropSample&&this.directBackdropSample)&&!this.backgroundColor&&this.wallpaperTexture);return{sx:x,sy:v,sw:T,sh:p,radii:C,scaleX:d,scaleY:c,isButton:s,p:a,togglePressProgress:b,translationX:i,translationY:l,independent:L}}function Me(e,r){return!(e.isToggleKnob||e.isBottomTabIndicator||e.blurRadius<.5||e.sampleWallpaper||e.isSdfTexture&&!e.isSdfTexture.useSeparableBlur)}function We(e){let{el:r,st:t,transform:s,usePerElementFbo:a,sceneRectOffsetX:o,sceneRectOffsetY:n,elFboW:i,elFboH:l}=e,{sx:d,sy:c,sw:u,sh:h,radii:f,scaleX:b,scaleY:m,isButton:g,p:T,togglePressProgress:p,independent:x}=s;return{el:r,st:t,isButton:g,p:T,sx:d,sy:c,sw:u,sh:h,radii:f,togglePressProgress:p,elHighlightAlpha:r.isToggleKnob||r.isBottomTabIndicator?(r.highlight?r.highlight.alpha:0)*p:r.highlight?r.highlight.alpha:0,enterAlpha:(r.enterProgress!=null?pe(r.enterSafeProgress!=null?Math.max(0,Math.min(1,r.enterSafeProgress)):Math.max(0,Math.min(1,r.enterProgress))):1)*(r.elementAlpha??1),layerScaleX:b,layerScaleY:m,layerScale:Math.min(b,m),origW:r.rect.w,origH:r.rect.h,origCornerRadius:r.cornerRadius,elementRotation:r.elementRotation??0,independent:x,usePerElementFbo:a,sceneRectOffsetX:o,sceneRectOffsetY:n,elFboW:i,elFboH:l}}function Ne(e,r,t){let{el:s,independent:a,sx:o,sy:n,sw:i,sh:l,layerScale:d}=e;if(a&&Me(s,e)&&this.quickToggles.backdropBlur){let c=this.gl,u=s.blurRadius*d*this.dpr,h=s.blurRadius*d,f=Math.round(h*10)/10,b=this.useBlurCache?`wallpaper_${f}_${this.useKawaseBlur?"k":"g"}`:null,m=b?this.backdropBlurCache.get(b):void 0,g,T=!1;if(m)g=m.tex,T=!0,this.lastBlurStats={type:m.blurType,passes:0,taps:0,maxSample:0,w:m.w,h:m.h,progMs:0,stateMs:0,drawMs:0};else if(!b)g=this.blurTexture(this.wallpaperBlurTex,u);else{if(this._blurCacheMissesThisFrame>=this.blurCacheMissesPerFrame)return{backdropTex:r,didBlur:!1};this._blurCacheMissesThisFrame++;let x=performance.now(),v=this.blurTexture(this.wallpaperBlurTex,u),S=performance.now(),C=this.lastBlurStats?.progMs??0,M=this.lastBlurStats?.stateMs??0,L=this.lastBlurStats?.drawMs??S-x,R=this.lastBlurStats?.w??this.dsBlurFboW??this.fboW,E=this.lastBlurStats?.h??this.dsBlurFboH??this.fboH,F=this.acquireCacheFBO(R,E),y=this.gl,U=y.getParameter(y.FRAMEBUFFER_BINDING),w=y.isEnabled(y.SCISSOR_TEST),W=y.getParameter(y.SCISSOR_BOX);if(y.disable(y.SCISSOR_TEST),this.cacheCopyReadFbo||(this.cacheCopyReadFbo=y.createFramebuffer()),y.bindFramebuffer(y.FRAMEBUFFER,this.cacheCopyReadFbo),y.framebufferTexture2D(y.FRAMEBUFFER,y.COLOR_ATTACHMENT0,y.TEXTURE_2D,v,0),y.activeTexture(y.TEXTURE0),y.bindTexture(y.TEXTURE_2D,null),y.bindTexture(y.TEXTURE_2D,F.tex),y.copyTexImage2D(y.TEXTURE_2D,0,y.RGBA,0,0,R,E,0),this.showBlurCacheCheckerboard){y.bindFramebuffer(y.FRAMEBUFFER,F.fb),y.viewport(0,0,R,E);let te=Math.max(8,Math.floor(R/20));y.enable(y.SCISSOR_TEST),y.clearColor(0,0,0,0);for(let A=0;A<E;A+=te)for(let _=0;_<R;_+=te)(Math.floor(_/te)+Math.floor(A/te))%2!==0&&(y.scissor(_,A,Math.min(te,R-_),Math.min(te,E-A)),y.clear(y.COLOR_BUFFER_BIT));y.disable(y.SCISSOR_TEST)}let k=performance.now(),P=S-x,X=k-S,$=0,Y=0,B=0,G=0,K=new Uint8Array(0),j=0,re=0,ne=0,ae=0,oe=0;if(this.showBlurCachePreview){B=R,G=E;let te=performance.now();K=new Uint8Array(B*G*4);let A=performance.now();y.bindFramebuffer(y.FRAMEBUFFER,F.fb),y.readPixels(0,0,B,G,y.RGBA,y.UNSIGNED_BYTE,K);let _=performance.now();for(let q=0;q<G;q++)for(let O=0;O<B;O++){let D=(q*B+O)*4;K[D]+K[D+1]+K[D+2]+K[D+3]>0&&(j++,(O<re||j===1)&&(re=O),O>ae&&(ae=O),(q<ne||j===1)&&(ne=q),q>oe&&(oe=q))}let V=performance.now();$=_-A,Y=V-_+(A-te)}this.backdropBlurCacheSnapshots.push({key:B>0?`${b} [${re},${ne}-${ae},${oe}]`:b,w:B,h:G,rgba:K,nonZero:j,progMs:C,stateMs:M,drawMs:L,copyMs:X,readPixelsMs:$,scanMs:Y,totalMs:C+M+L+X+$+Y}),this.bindFBO(U),w&&(y.enable(y.SCISSOR_TEST),y.scissor(W[0],W[1],W[2],W[3])),this.backdropBlurCache.set(b,{fb:F.fb,tex:F.tex,w:R,h:E,blurType:this.lastBlurStats?.type??"gauss"}),this.evictBackdropBlurCacheIfNeeded(),g=F.tex}if(this.showBlurDebug){let x=this.lastBlurStats;this.debugBlurRegions.push({x:o,y:n,w:i,h:l,radius:u,ds:this.effectiveBlurDownsample,blurW:this.dsBlurFboW,blurH:this.dsBlurFboH,blurType:x?.type??"gauss",passes:x?.passes??0,taps:x?.taps??0,maxSample:x?.maxSample??0,cached:T})}this.perfMonitor.incBlurPass(),this.perfMonitor.incDrawCall(3),c.enable(c.BLEND),c.blendFunc(c.SRC_ALPHA,c.ONE_MINUS_SRC_ALPHA),this.bindFBO(t),c.viewport(0,0,this.fboW,this.fboH);let p={...e,independent:!1};return{backdropTex:g,passState:p,didBlur:!0}}if(a)return{backdropTex:r,didBlur:!1};if(Me(s,e)&&this.quickToggles.backdropBlur){let c=s.blurRadius*d*this.dpr,u;s.backdropFbo&&this.dialogBackdropTex?u=this.dialogBackdropTex:this.quickToggles.isolateBackdrop&&this.bgOnlyTex?u=this.bgOnlyTex:u=r;let h=this.useBlurCache&&u===r&&!s.backdropFbo,f=this.scrollY!==this._lastBlurCacheScrollY;this._lastBlurCacheScrollY=this.scrollY;let b=s.blurRadius*d,m=Math.round(b*10)/10,g=h&&!f?`scene_${s.id}_${m}_${this.useKawaseBlur?"k":"g"}`:null,T,p=!1;if(g){let S=this.backdropBlurCache.get(g);if(S)T=S.tex,p=!0,this.lastBlurStats={type:S.blurType,passes:0,taps:0,maxSample:0,w:S.w,h:S.h,progMs:0,stateMs:0,drawMs:0};else{if(this._blurCacheMissesThisFrame>=this.blurCacheMissesPerFrame)return{backdropTex:u,didBlur:!1};this._blurCacheMissesThisFrame++;let C=performance.now();T=this.blurTexture(u,c);let M=performance.now(),L=this.lastBlurStats?.progMs??0,R=this.lastBlurStats?.stateMs??0,E=this.lastBlurStats?.drawMs??M-C,F=this.lastBlurStats?.w??this.dsBlurFboW??this.fboW,y=this.lastBlurStats?.h??this.dsBlurFboH??this.fboH,U=this.acquireCacheFBO(F,y),w=this.gl,W=w.getParameter(w.FRAMEBUFFER_BINDING),k=w.isEnabled(w.SCISSOR_TEST),P=w.getParameter(w.SCISSOR_BOX);if(w.disable(w.SCISSOR_TEST),this.cacheCopyReadFbo||(this.cacheCopyReadFbo=w.createFramebuffer()),w.bindFramebuffer(w.FRAMEBUFFER,this.cacheCopyReadFbo),w.framebufferTexture2D(w.FRAMEBUFFER,w.COLOR_ATTACHMENT0,w.TEXTURE_2D,T,0),w.activeTexture(w.TEXTURE0),w.bindTexture(w.TEXTURE_2D,null),w.bindTexture(w.TEXTURE_2D,U.tex),w.copyTexImage2D(w.TEXTURE_2D,0,w.RGBA,0,0,F,y,0),this.showBlurCacheCheckerboard){w.bindFramebuffer(w.FRAMEBUFFER,U.fb),w.viewport(0,0,F,y);let A=Math.max(8,Math.floor(F/20));w.enable(w.SCISSOR_TEST),w.clearColor(0,0,0,0);for(let _=0;_<y;_+=A)for(let V=0;V<F;V+=A)(Math.floor(V/A)+Math.floor(_/A))%2!==0&&(w.scissor(V,_,Math.min(A,F-V),Math.min(A,y-_)),w.clear(w.COLOR_BUFFER_BIT));w.disable(w.SCISSOR_TEST)}let $=performance.now()-M,Y=0,B=0,G=0,K=0,j=new Uint8Array(0),re=0,ne=0,ae=0,oe=0,te=0;if(this.showBlurCachePreview){G=F,K=y;let A=performance.now();j=new Uint8Array(G*K*4);let _=performance.now();w.bindFramebuffer(w.FRAMEBUFFER,U.fb),w.readPixels(0,0,G,K,w.RGBA,w.UNSIGNED_BYTE,j);let V=performance.now();for(let O=0;O<K;O++)for(let D=0;D<G;D++){let I=(O*G+D)*4;j[I]+j[I+1]+j[I+2]+j[I+3]>0&&(re++,(D<ne||re===1)&&(ne=D),D>oe&&(oe=D),(O<ae||re===1)&&(ae=O),O>te&&(te=O))}let q=performance.now();Y=V-_,B=q-V+(_-A)}this.backdropBlurCacheSnapshots.push({key:G>0?`${g} [${ne},${ae}-${oe},${te}]`:g,w:G,h:K,rgba:j,nonZero:re,progMs:L,stateMs:R,drawMs:E,copyMs:$,readPixelsMs:Y,scanMs:B,totalMs:L+R+E+$+Y+B}),w.bindFramebuffer(w.FRAMEBUFFER,W),k&&(w.enable(w.SCISSOR_TEST),w.scissor(P[0],P[1],P[2],P[3])),this.backdropBlurCache.set(g,{fb:U.fb,tex:U.tex,w:F,h:y,blurType:this.lastBlurStats?.type??"gauss"}),this.evictBackdropBlurCacheIfNeeded(),T=U.tex}}else{if(this.useBlurCache&&this._blurCacheMissesThisFrame>=this.blurCacheMissesPerFrame)return{backdropTex:u,didBlur:!1};this.useBlurCache&&this._blurCacheMissesThisFrame++,T=this.blurTexture(u,c)}if(this.showBlurDebug){let S=this.lastBlurStats;this.debugBlurRegions.push({x:o,y:n,w:i,h:l,radius:c,ds:this.effectiveBlurDownsample,blurW:this.dsBlurFboW,blurH:this.dsBlurFboH,blurType:S?.type??"gauss",passes:S?.passes??0,taps:S?.taps??0,maxSample:S?.maxSample??0,cached:p})}this.perfMonitor.incBlurPass(),this.perfMonitor.incDrawCall(2);let x=this.gl;x.enable(x.BLEND),x.blendFunc(x.SRC_ALPHA,x.ONE_MINUS_SRC_ALPHA),this.bindFBO(t),x.viewport(0,0,this.fboW,this.fboH);let v=s.backdropFbo?{...e,el:{...s,backdropFbo:!1}}:e;return{backdropTex:T,passState:v,didBlur:!0}}return this.quickToggles.isolateBackdrop&&this.bgOnlyTex&&!s.backdropFbo?{backdropTex:this.bgOnlyTex,didBlur:!1}:{backdropTex:r,didBlur:!1}}function nr(e,r,t,s,a,o,n){let i=this.gl,l=ir.call(this,e,r,n),{sx:d,sy:c,sw:u,sh:h,scaleX:f,scaleY:b,togglePressProgress:m}=l;if(this.quickToggles.perElementFbo){this.perfMonitor.incGlassElement(),this.perfMonitor.incPerElementFbo();let L=this.allDirty||this.dirtyElementIds.has(e.id);return this.renderGlassElementPerFbo(e,r,t,s,a,o,{sx:d,sy:c,sw:u,sh:h,radii:l.radii,scaleX:f,scaleY:b,isButton:l.isButton,p:l.p,togglePressProgress:m,independent:l.independent,translationX:l.translationX,translationY:l.translationY,elDirty:L})}this._dbgLastGlassCacheHit=!1,this.showDirtyMarkers&&this.debugCacheMissLog.push({id:e.id,reason:"ping_pong",x:d,y:c,w:u,h}),this.dirtyRectsThisFrame.push({...de(e,d,c,u,h,m),source:`pingpong:${e.id}`}),this.perfMonitor.incGlassElement(),this.perfMonitor.incPingPong(),this.bindFBO(a),this.drawCopy(s),this.perfMonitor.incDrawCall(),i.enable(i.BLEND),i.blendFunc(i.SRC_ALPHA,i.ONE_MINUS_SRC_ALPHA);let g=Fe(e,Math.min(f,b),this.quickToggles),T=Math.max(0,Math.round((d-g)*this.dpr)),p=Math.max(0,Math.round((this.cssHeight-(c+h+g))*this.dpr)),x=Math.min(this.fboW-T,Math.round((u+2*g)*this.dpr)),v=Math.min(this.fboH-p,Math.round((h+2*g)*this.dpr)),S=this.intersectClipScissor(e,T,p,x,v);if(i.enable(i.SCISSOR_TEST),i.scissor(S.x,S.y,S.w,S.h),this.showPefBbox){let L=T/this.dpr,R=(this.fboH-p-v)/this.dpr;this.debugPefBboxes.push({x:L,y:R,w:x/this.dpr,h:v/this.dpr,fbo:!1})}let C=We({el:e,st:r,transform:l,usePerElementFbo:!1,sceneRectOffsetX:0,sceneRectOffsetY:0,elFboW:0,elFboH:0});this.renderGlassShadowPass(C);let M=Ne.call(this,C,s,a);return this.renderGlassElementPass(M.passState??C,M.backdropTex,M.backdropBbox),this.renderGlassPostPasses(C),i.disable(i.SCISSOR_TEST),{curFbo:a,curTex:o,otherFbo:t,otherTex:s}}function yt(e,r,t,s,a,o){let n=Fe(e,o,this.quickToggles),l=(2+1)/this.dpr,d=Math.round((r-n)*this.dpr),c=Math.round((t-n)*this.dpr),u=Math.max(0,Math.min(this.fboW,d)),h=Math.max(0,Math.min(this.fboH,c)),f=Math.max(0,Math.min(this.fboW-u,Math.round((s+2*n)*this.dpr))),b=Math.max(0,Math.min(this.fboH-h,Math.round((a+2*n)*this.dpr))),m=Math.max(0,this.fboH-h-b),g=Math.max(1,Math.round((e.rect.w+2*l)*this.dpr)),T=Math.max(1,Math.round((e.rect.h+2*l)*this.dpr)),p=Math.round((r-l)*this.dpr),x=Math.round((t-l)*this.dpr),v=p,S=x,C=Math.max(0,Math.min(this.fboW,p)),M=Math.max(0,Math.min(this.fboH,x)),L=Math.max(0,Math.min(this.fboW-C,g)),R=Math.max(0,Math.min(this.fboH-M,T)),E=Math.max(0,this.fboH-M-R);return{bx0:u,by0Top:h,bboxW:f,bboxH:b,bboxScissorY:m,elFboRectW:g,elFboRectH:T,ex0:v,ey0Top:S,scissorX:C,scissorYTop:M,scissorW:L,scissorH:R,elFboScissorY:E,sceneOffsetX:p,sceneOffsetY:x,scissorMarginCss:n}}function At(e){let r=!!(this.wallpaperTexture&&!e.backdropFbo),t=!!(e.isToggleKnob?.solidBackdropColor&&!e.backdropFbo),s=!!(e.isToggleKnob&&!e.isToggleKnob.solidBackdropColor&&!e.isToggleKnob.trackColorOff&&this.backgroundColor&&!e.backdropFbo);return{cacheable:r,positionInvariant:t,scrollInvariant:s}}function ls(e,r,t){for(let s=0;s<e.length;s++){let a=e[s];if(!(t&&a.source==="scroll")&&Rt(a,r))return a}return null}function wt(e,r,t,s){let{sx:a,sy:o,sw:n,sh:i,togglePressProgress:l,independent:d}=r,{elFboRectW:c,elFboRectH:u,sceneOffsetX:h,sceneOffsetY:f}=t,{cacheable:b,positionInvariant:m,scrollInvariant:g}=s,T=this.gl;if(!b){if(this.showDirtyMarkers){let M=this.wallpaperTexture?e.backdropFbo?"non_cacheable:backdropFbo":"non_cacheable:unknown":"non_cacheable:no_wp";this.debugCacheMissLog.push({id:e.id,reason:M,x:a,y:o,w:n,h:i})}let C=this.ensureElementFBO(c,u);return{cacheHit:!1,cacheWrite:!1,renderFbo:this.elFbo,renderTex:this.elFboTex,elFboW:C.w,elFboH:C.h}}let p=this.elFboCache.get(e.id),x=null,v=m||g;if(!p)x="no_entry";else if(p.w!==c||p.h!==u)x="size_mismatch";else if(!v&&(p.ex0!==h||p.ey0Top!==f))x="position_mismatch";else if(!p.valid)x="invalidated";else if(p.wallpaperVersion!==this.wallpaperVersion)x="wallpaper_version";else if(p.dpr!==this.dpr)x="dpr";else if(!m&&!d&&this.dirtyRectsThisFrame.length>0){let C=de(e,a,o,n,i,l),M=ls(this.dirtyRectsThisFrame,C,g);M&&(x=`backdrop_overlap:${M.source}`)}if(x&&this.showDirtyMarkers&&this.debugCacheMissLog.push({id:e.id,reason:x,x:a,y:o,w:n,h:i}),p&&x===null)return(m||g)&&(p.ex0=h,p.ey0Top=f),this.perfMonitor.incCachedElement(),{cacheHit:!0,cacheWrite:!1,renderFbo:p.fb,renderTex:p.tex,elFboW:p.w,elFboH:p.h};if(p){if(p.w!==c||p.h!==u){T.deleteFramebuffer(p.fb),T.deleteTexture(p.tex);let C=this.createFBO(c,u);p.fb=C.fb,p.tex=C.tex,p.w=c,p.h=u}}else{let C=this.createFBO(c,u);this.elFboCache.set(e.id,{fb:C.fb,tex:C.tex,w:c,h:u,ex0:h,ey0Top:f,valid:!1,wallpaperVersion:this.wallpaperVersion,dpr:this.dpr})}let S=this.elFboCache.get(e.id);return S.ex0=h,S.ey0Top=f,S.valid=!1,S.wallpaperVersion=this.wallpaperVersion,S.dpr=this.dpr,{cacheHit:!1,cacheWrite:!0,renderFbo:S.fb,renderTex:S.tex,elFboW:S.w,elFboH:S.h}}function lr(e,r,t,s,a,o,n){let i=this.gl,l=Math.min(n.scaleX,n.scaleY),d=yt.call(this,e,n.sx,n.sy,n.sw,n.sh,l),c=e.elementRotation??0,u=Math.abs(Math.cos(c)),h=Math.abs(Math.sin(c)),f=d.scissorMarginCss,b=n.sw+2*f,m=n.sh+2*f,g=b*u+m*h,T=b*h+m*u,p=n.sx+n.sw/2,x=n.sy+n.sh/2,v=Math.max(0,Math.min(this.fboW,Math.round((p-g/2)*this.dpr))),S=Math.max(0,Math.min(this.fboH,Math.round((this.cssHeight-(x+T/2))*this.dpr))),C=Math.max(0,Math.min(this.fboW-v,Math.round(g*this.dpr))),M=Math.max(0,Math.min(this.fboH-S,Math.round(T*this.dpr)));this.showPefBbox&&this.debugPefBboxes.push({x:d.ex0/this.dpr,y:d.ey0Top/this.dpr,w:d.elFboRectW/this.dpr,h:d.elFboRectH/this.dpr,fbo:!0});let L=At.call(this,e),R=We({el:e,st:r,transform:n,usePerElementFbo:!0,sceneRectOffsetX:d.sceneOffsetX,sceneRectOffsetY:d.sceneOffsetY,elFboW:0,elFboH:0}),E=wt.call(this,e,R,d,L);R.elFboW=E.elFboW,R.elFboH=E.elFboH;let F=this.intersectClipScissor(e,v,S,C,M);if(this.bindFBO(t),i.enable(i.SCISSOR_TEST),i.scissor(F.x,F.y,F.w,F.h),i.enable(i.BLEND),i.blendFunc(i.SRC_ALPHA,i.ONE_MINUS_SRC_ALPHA),this.renderGlassShadowPass(R),!E.cacheHit){this.dirtyRectsThisFrame.push({...de(e,n.sx,n.sy,n.sw,n.sh,n.togglePressProgress),source:`glass:${e.id}`});let G=Ne.call(this,R,s,E.renderFbo);if(i.bindFramebuffer(i.FRAMEBUFFER,E.renderFbo),i.viewport(0,0,E.elFboW,E.elFboH),i.disable(i.SCISSOR_TEST),i.clearColor(0,0,0,0),i.clear(i.COLOR_BUFFER_BIT),i.disable(i.BLEND),this.renderGlassElementPass(G.passState??R,G.backdropTex,G.backdropBbox),E.cacheWrite){let K=this.elFboCache.get(e.id);K&&(K.valid=!0)}}let y=p,U=x,w=n.sw*u+n.sh*h,W=n.sw*h+n.sh*u,k=Math.max(0,Math.min(this.fboW,Math.round((y-w/2)*this.dpr))),P=Math.max(0,Math.min(this.fboH,Math.round((this.cssHeight-(U+W/2))*this.dpr))),X=Math.max(0,Math.min(this.fboW-k,Math.round(w*this.dpr))),$=Math.max(0,Math.min(this.fboH-P,Math.round(W*this.dpr))),Y=this.intersectClipScissor(e,k,P,X,$);this.bindFBO(t),i.enable(i.SCISSOR_TEST),i.scissor(Y.x,Y.y,Y.w,Y.h),this.drawElFboComposite(E.renderTex,E.elFboW,E.elFboH,y*this.dpr,U*this.dpr,n.sw*this.dpr,n.sh*this.dpr,c);let B=this.intersectClipScissor(e,v,S,C,M);if(i.scissor(B.x,B.y,B.w,B.h),this.renderGlassPostPasses(R),i.disable(i.SCISSOR_TEST),this._dbgLastGlassCacheHit=E.cacheHit,this.showPefPassDebug){let G=d.ex0/this.dpr,K=d.ey0Top/this.dpr,j=d.elFboRectW/this.dpr,re=d.elFboRectH/this.dpr,ne=d.bx0/this.dpr,ae=d.by0Top/this.dpr,oe=d.bboxW/this.dpr,te=d.bboxH/this.dpr;this.debugPefPasses.push({id:e.id,cacheHit:E.cacheHit,missReason:E.cacheHit?null:"MISS",composite:{x:G,y:K,w:j,h:re},postPass:{x:ne,y:ae,w:oe,h:te},isBottomTabIndicator:!!e.isBottomTabIndicator,togglePressProgress:R.togglePressProgress,elHighlightAlpha:R.elHighlightAlpha})}return{curFbo:t,curTex:s,otherFbo:a,otherTex:o}}function ur(e){let r=this.gl,{el:t,sx:s,sy:a,sw:o,sh:n,radii:i}=e;if(!t.outerShadow||t.outerShadow.radius<=.5||!this.quickToggles.outerShadow)return;let l=t.outerShadow.alpha;if(t.isBottomTabIndicator&&(l*=e.togglePressProgress),this.showShadowBbox){let d=Et(t,s,a,o,n,e.layerScaleX,e.layerScaleY,this.quickToggles);d&&this.debugShadowBboxes.push({...d,alpha:l,skipped:l<=.001,r:t.outerShadow.radius,ox:t.outerShadow.offsetX,oy:t.outerShadow.offsetY})}l<=.001||(r.useProgram(this.shadowProgram),r.bindBuffer(r.ARRAY_BUFFER,this.quadBuffer),r.enableVertexAttribArray(this.aPosLocSh),r.vertexAttribPointer(this.aPosLocSh,2,r.FLOAT,!1,0,0),r.blendFunc(r.SRC_ALPHA,r.ONE_MINUS_SRC_ALPHA),r.uniform2f(this.uSh.uCanvasSize,this.canvas.width,this.canvas.height),r.uniform2f(this.uSh.uElementOffset,s*this.dpr,a*this.dpr),r.uniform2f(this.uSh.uElementSize,o*this.dpr,n*this.dpr),r.uniform4f(this.uSh.uCornerRadii,i[0]*this.dpr,i[1]*this.dpr,i[2]*this.dpr,i[3]*this.dpr),r.uniform2f(this.uSh.uOriginalSize,e.origW*this.dpr,e.origH*this.dpr),r.uniform1f(this.uSh.uOriginalCornerRadius,e.origCornerRadius*this.dpr),r.uniform2f(this.uSh.uLayerScale,e.layerScaleX,e.layerScaleY),r.uniform1f(this.uSh.uElementRotation,e.elementRotation),r.uniform1f(this.uSh.uCornerStyle,this.cornerStyle),r.uniform1f(this.uSh.uShadowRadius,t.outerShadow.radius*this.dpr),r.uniform2f(this.uSh.uShadowOffset,t.outerShadow.offsetX*this.dpr,t.outerShadow.offsetY*this.dpr),r.uniform4f(this.uSh.uShadowColor,t.outerShadow.color[0],t.outerShadow.color[1],t.outerShadow.color[2],l),r.drawArrays(r.TRIANGLES,0,6))}var cr={renderGlassElement:nr,renderGlassElementPerFbo:lr,renderGlassShadowPass:ur};var dr={render(){if(this.contextLost){this.perfMonitor.frameEnd();return}if(!this.needsRedraw)return;if(this.needsRedraw=!1,this.dirtyRectsThisFrame.length=0,this.debugCacheMissLog.length=0,this.debugDirtySourceLog.length=0,this._blurCacheMissesThisFrame=0,(this.allDirty||this.scrollY!==this.lastRenderedScrollY)&&this.dirtyRectsThisFrame.push({x:0,y:0,w:this.cssWidth,h:this.cssHeight,source:this.allDirty?"all_dirty":"scroll"}),this.lastRenderedScrollY=this.scrollY,this.perfMonitor.canvasCssW=this.cssWidth,this.perfMonitor.canvasCssH=this.cssHeight,this.perfMonitor.canvasDevW=this.canvas.width,this.perfMonitor.canvasDevH=this.canvas.height,this.perfMonitor.dpr=this.dpr,this.perfMonitor.deviceDpr=typeof window<"u"&&window.devicePixelRatio||1,this.perfMonitor.frameStart(),this.debugPefBboxes.length=0,this.debugBlurRegions.length=0,this.debugShadowBboxes.length=0,this.debugDirtyMarkers.length=0,this.debugCullRects.length=0,this.debugPefPasses.length=0,this.debugPlainRects.length=0,!this.wallpaperReady&&!this.backgroundColor){this.perfMonitor.frameEnd();return}let e=this.gl;this.resizeFBOs(this.canvas.width,this.canvas.height);for(let u of this.buttonConfigs)this.fgDirtyIds.has(u.id)&&this.rasterizeForeground(u);if(this.renderBackground(),this.perfMonitor.incDrawCall(),this.buttonConfigs.length===0){this.bindFBO(null),this.drawCopy(this.fboATex),this.perfMonitor.incDrawCall(),this.perfMonitor.frameEnd();return}let r=this.buttonConfigs.find(u=>(u.sceneBlurRadius??0)>=.5);if(r){let u=r.sceneBlurRadius*this.dpr,h=this.blurTexture(this.fboATex,u);this.bindFBO(this.fboA),this.drawCopy(h),this.perfMonitor.incBlurPass(),this.perfMonitor.incDrawCall(2)}e.enable(e.BLEND),e.blendFunc(e.SRC_ALPHA,e.ONE_MINUS_SRC_ALPHA);let t=this.quickToggles.isolateBackdrop;t&&this.bgOnlyFbo&&this.bgOnlyTex&&(this.bindFBO(this.bgOnlyFbo),this.gl.viewport(0,0,this.fboW,this.fboH),this.drawCopy(this.fboATex),this.gl.enable(this.gl.BLEND),this.gl.blendFunc(this.gl.SRC_ALPHA,this.gl.ONE_MINUS_SRC_ALPHA));let s=this.scrollY,a=120,o=u=>Math.max(a,u.rect.h),n=u=>{let h=u.scroll?u.rect.y-s:u.rect.y;return{x:u.rect.x,y:h,w:u.rect.w,h:u.rect.h}},i=this.fboA,l=this.fboATex,d=this.fboB,c=this.fboBTex;for(let u of this.buttonConfigs){if(u.renderOnTop)continue;let h=u.scroll?u.rect.y-s:u.rect.y,f=o(u),b=h+u.rect.h<-f||h>this.cssHeight+f;if(this.showCullDebug&&this.debugCullRects.push({id:u.id,x:u.rect.x,y:h,w:u.rect.w,h:u.rect.h,margin:f,culled:b,scroll:!!u.scroll,viewportH:this.cssHeight,pass:"main"}),b)continue;let m=n(u),g=this.buttonStates.get(u.id),T=this.allDirty||this.dirtyElementIds.has(u.id);if(this.perfMonitor.incTotal(),T&&this.perfMonitor.incDirty(),this.renderNonGlassElement(u,m,g,i)){this.showDirtyMarkers&&this.debugDirtyMarkers.push({x:m.x,y:m.y,w:m.w,h:m.h,dirty:T}),T&&this.dirtyRectsThisFrame.push({...de(u,m.x,m.y,m.w,m.h),source:`nonglass:${u.id}`}),t&&this.bgOnlyFbo&&this.renderNonGlassElement(u,m,g,this.bgOnlyFbo);continue}u.backdropFbo&&u.scrimColor&&this.renderDialogBackdrop(u.scrimColor,u.brightness,u.contrast,u.saturation),u.useContinuousSdf&&this.loadContinuousSdf(u.rect.w,u.rect.h,u.cornerRadius);let p=this.renderGlassElement(u,g,i,l,d,c,m);i=p.curFbo,l=p.curTex,d=p.otherFbo,c=p.otherTex,this.showDirtyMarkers&&this.debugDirtyMarkers.push({x:m.x,y:m.y,w:m.w,h:m.h,dirty:!this._dbgLastGlassCacheHit}),u.isBottomTabContainer&&this.tabsBackdropFbo&&this.tabsBackdropTex&&(this.bindFBO(this.tabsBackdropFbo),this.gl.clearColor(0,0,0,0),this.gl.clear(this.gl.COLOR_BUFFER_BIT),this.drawCopy(l),this.bindFBO(i),this.gl.enable(this.gl.BLEND),this.gl.blendFunc(this.gl.SRC_ALPHA,this.gl.ONE_MINUS_SRC_ALPHA))}for(let u of this.buttonConfigs){if(!u.renderOnTop)continue;let h=u.scroll?u.rect.y-s:u.rect.y,f=o(u),b=h+u.rect.h<-f||h>this.cssHeight+f;if(this.showCullDebug&&this.debugCullRects.push({id:u.id,x:u.rect.x,y:h,w:u.rect.w,h:u.rect.h,margin:f,culled:b,scroll:!!u.scroll,viewportH:this.cssHeight,pass:"onTop"}),b)continue;let m=n(u),g=this.buttonStates.get(u.id),T=this.allDirty||this.dirtyElementIds.has(u.id);if(this.perfMonitor.incTotal(),T&&this.perfMonitor.incDirty(),this.renderNonGlassElement(u,m,g,i)){this.showDirtyMarkers&&this.debugDirtyMarkers.push({x:m.x,y:m.y,w:m.w,h:m.h,dirty:T}),T&&this.dirtyRectsThisFrame.push({...de(u,m.x,m.y,m.w,m.h),source:`nonglass:${u.id}`}),t&&this.bgOnlyFbo&&this.renderNonGlassElement(u,m,g,this.bgOnlyFbo);continue}let p=this.renderGlassElement(u,g,i,l,d,c,m);i=p.curFbo,l=p.curTex,d=p.otherFbo,c=p.otherTex,this.showDirtyMarkers&&this.debugDirtyMarkers.push({x:m.x,y:m.y,w:m.w,h:m.h,dirty:!this._dbgLastGlassCacheHit})}if(this.bindFBO(null),this.drawCopy(l),this.perfMonitor.incDrawCall(),this._pendingEdgeScan&&this._debugFlushPendingEdgeScan(),this.dirtyElementIds.clear(),this.allDirty=!1,this.pendingExtraRenders>0){this.pendingExtraRenders--;for(let u of this.buttonConfigs)u.isBottomTabIndicator&&this.markGroupDirty(u.isBottomTabIndicator.groupId);this.requestRender()}this.perfMonitor.frameEnd()}};var hr={setSdfUniforms(e,r,t,s){let a=this.gl;a.bindBuffer(a.ARRAY_BUFFER,this.quadBuffer),a.enableVertexAttribArray(r),a.vertexAttribPointer(r,2,a.FLOAT,!1,0,0),a.uniform2f(e.uCanvasSize,this.canvas.width,this.canvas.height),a.uniform2f(e.uOffset,t.x*this.dpr,t.y*this.dpr),a.uniform2f(e.uSize,t.w*this.dpr,t.h*this.dpr),a.uniform4f(e.uCornerRadii,s*this.dpr,s*this.dpr,s*this.dpr,s*this.dpr)},renderBackground(){let e=this.gl;if(this.bindFBO(this.fboA),e.disable(e.BLEND),this.overlayMode&&(e.clearColor(0,0,0,0),e.clear(e.COLOR_BUFFER_BIT)),this.backgroundColor){if(!this.overlayMode){let[r,t,s]=this.backgroundColor;this.drawSolidFill(r,t,s,1)}}else e.useProgram(this.wallpaperProgram),e.bindBuffer(e.ARRAY_BUFFER,this.quadBuffer),e.enableVertexAttribArray(this.aPosLocWp),e.vertexAttribPointer(this.aPosLocWp,2,e.FLOAT,!1,0,0),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,this.wallpaperTexture),e.uniform1i(this.uWp.uBackdrop,0),e.uniform2f(this.uWp.uCanvasSize,this.canvas.width,this.canvas.height),e.uniform2f(this.uWp.uWallpaperSize,this.wallpaperSize[0],this.wallpaperSize[1]),this.wallpaperBlurFbo&&(e.bindFramebuffer(e.FRAMEBUFFER,this.wallpaperBlurFbo),e.viewport(0,0,this.fboW,this.fboH),e.disable(e.SCISSOR_TEST),e.drawArrays(e.TRIANGLES,0,6)),this.overlayMode||(this.bindFBO(this.fboA),e.viewport(0,0,this.fboW,this.fboH),e.disable(e.SCISSOR_TEST),e.drawArrays(e.TRIANGLES,0,6))},renderDialogBackdrop(e,r,t,s){let a=`${e.join(",")}|${r},${t},${s}`;if(this.dialogBackdropKey===a)return;this.dialogBackdropKey=a;let o=this.gl;if(this.bindFBO(this.dialogBackdropFbo),o.disable(o.BLEND),this.backgroundColor){let[n,i,l]=this.backgroundColor;this.drawSolidFill(n,i,l,1)}else o.useProgram(this.wallpaperProgram),o.bindBuffer(o.ARRAY_BUFFER,this.quadBuffer),o.enableVertexAttribArray(this.aPosLocWp),o.vertexAttribPointer(this.aPosLocWp,2,o.FLOAT,!1,0,0),o.activeTexture(o.TEXTURE0),o.bindTexture(o.TEXTURE_2D,this.wallpaperTexture),o.uniform1i(this.uWp.uBackdrop,0),o.uniform2f(this.uWp.uCanvasSize,this.canvas.width,this.canvas.height),o.uniform2f(this.uWp.uWallpaperSize,this.wallpaperSize[0],this.wallpaperSize[1]),o.drawArrays(o.TRIANGLES,0,6);e[3]>.001&&(o.enable(o.BLEND),o.blendFuncSeparate(o.SRC_ALPHA,o.ONE_MINUS_SRC_ALPHA,o.ONE,o.ONE_MINUS_SRC_ALPHA),this.drawSolidFill(e[0],e[1],e[2],e[3]),o.blendFunc(o.SRC_ALPHA,o.ONE_MINUS_SRC_ALPHA)),this.bindFBO(this.blurFboA),this.drawColorControls(this.dialogBackdropTex,r,t,s),this.bindFBO(this.dialogBackdropFbo),this.drawCopy(this.blurFboATex)}};var fr={renderNonGlassElement(e,r,t,s){let a=r;if(e.enterProgress!=null){let o=e.enterProgress,n=o<0?(1-Math.exp(-Math.abs(o)))*-1:o<=1?o:1+(1-Math.exp(-(o-1))),i=-48*1*(1-n),l=e.enterStretchFactor!=null&&n>1?e.enterStretchFactor*(n-1)*32*1:0;a={x:r.x,y:r.y+i+l,w:r.w,h:r.h}}return e.kind==="plain-rect"&&e.plainRect?this.renderPlainRectElement(e,r,a,s):e.kind==="progressive-blur"&&e.progressiveBlur?this.renderProgressiveBlurElement(e,a,s):e.kind==="text"?this.renderTextElement(e,a,t,s):!1}};function Ft(e,r,t,s,a,o){return e?{verdict:"SKIPPED",detail:r??"unknown"}:!isFinite(t)||t<=0?{verdict:"INVISIBLE",detail:`finalAlpha=${t} (colorA*enterA)`}:s<=0||a<=0?{verdict:"DEGENERATE",detail:`rect ${s.toFixed(1)}x${a.toFixed(1)} \u2264 0`}:o?{verdict:"OK",detail:`finalAlpha=${t.toFixed(3)}`}:{verdict:"NO_OP",detail:"BLEND disabled by prior element"}}var mr={renderPlainRectElement(e,r,t,s){let a=this.gl,o=e.plainRect,n=e.isToggleTrack?null:o?.color??null;if(n&&n[3]<=0){if(this.showPlainRectDebug&&s!==this.bgOnlyFbo){let u=n,h=e.enterSafeProgress!=null?Math.max(0,Math.min(1,e.enterSafeProgress)):e.enterProgress!=null?Math.max(0,Math.min(1,e.enterProgress)):1,f=e.enterProgress!=null?pe(h):1,b=u[3]*f,m=this.gl.isEnabled(this.gl.BLEND),g=`color alpha=${u[3]} \u2264 0`,T=Ft(!0,g,b,t.w,t.h,m);this.debugPlainRects.push({id:e.id,x:t.x,y:t.y,w:t.w,h:t.h,origH:e.rect.h,colorR:u[0],colorG:u[1],colorB:u[2],colorA:u[3],enterProgress:e.enterProgress??null,enterSafeProgress:e.enterSafeProgress??null,enterA:f,finalAlpha:b,skipped:!0,skipReason:g,drawn:!1,blendEnabled:m,curFboIsA:s===this.fboA,diagnosis:T.verdict,diagnosisDetail:T.detail})}return!0}this.bindFBO(s);let i=!1;if(e.clipRect){let u=Math.max(0,Math.round(t.x*this.dpr)),h=Math.max(0,Math.round((this.cssHeight-(t.y+t.h))*this.dpr)),f=Math.min(this.fboW-u,Math.round(t.w*this.dpr)),b=Math.min(this.fboH-h,Math.round(t.h*this.dpr)),m=this.intersectClipScissor(e,u,h,f,b);a.enable(a.SCISSOR_TEST),a.scissor(m.x,m.y,m.w,m.h),i=!0}let l;if(e.isToggleTrack){let u=this.toggleStates.get(e.isToggleTrack.groupId),h=u?u.fraction:0,f=e.isToggleTrack.offColor,b=e.isToggleTrack.onColor;l=[f[0]+(b[0]-f[0])*h,f[1]+(b[1]-f[1])*h,f[2]+(b[2]-f[2])*h,f[3]+(b[3]-f[3])*h]}else l=o?.color??[0,0,0,0];let d=t;if(e.isSliderFill){let u=this.toggleStates.get(e.isSliderFill.groupId),h=u?u.fraction:0,f=Math.max(e.isSliderFill.minW,e.isSliderFill.trackW*h);d={x:r.x,y:r.y,w:f,h:r.h}}a.useProgram(this.plainRectProgram),this.setSdfUniforms(this.uPr,this.aPosLocPr,d,e.cornerRadius),a.blendFuncSeparate(a.SRC_ALPHA,a.ONE_MINUS_SRC_ALPHA,a.ONE,a.ONE_MINUS_SRC_ALPHA);let c=e.enterProgress!=null?(()=>{let u=e.enterSafeProgress!=null?Math.max(0,Math.min(1,e.enterSafeProgress)):Math.max(0,Math.min(1,e.enterProgress));return pe(u)})():1;if(a.uniform4f(this.uPr.uColor,l[0],l[1],l[2],l[3]*c),a.uniform1f(this.uPr.uCornerStyle,this.cornerStyle),e.useContinuousSdf&&this.loadContinuousSdf(t.w,t.h,e.cornerRadius),e.useContinuousSdf&&this.continuousSdfTexture?(a.activeTexture(a.TEXTURE2),a.bindTexture(a.TEXTURE_2D,this.continuousSdfTexture),a.uniform1i(this.uPr.uContinuousSdf,2),a.uniform1f(this.uPr.uUseContinuousSdf,1),a.uniform2f(this.uPr.uContinuousSdfTexSize,this.continuousSdfTexSize[0],this.continuousSdfTexSize[1]),a.uniform2f(this.uPr.uContinuousSdfElementSize,t.w*this.dpr,t.h*this.dpr)):a.uniform1f(this.uPr.uUseContinuousSdf,0),a.drawArrays(a.TRIANGLES,0,6),i&&a.disable(a.SCISSOR_TEST),this.perfMonitor.incNonGlass(),this.perfMonitor.incDrawCall(),this.showPlainRectDebug&&s!==this.bgOnlyFbo){let u=l[3]*c,h=this.gl.isEnabled(this.gl.BLEND),f=Ft(!1,null,u,d.w,d.h,h);this.debugPlainRects.push({id:e.id,x:d.x,y:d.y,w:d.w,h:d.h,origH:e.rect.h,colorR:l[0],colorG:l[1],colorB:l[2],colorA:l[3],enterProgress:e.enterProgress??null,enterSafeProgress:e.enterSafeProgress??null,enterA:c,finalAlpha:u,skipped:!1,skipReason:null,drawn:!0,blendEnabled:h,curFboIsA:s===this.fboA,diagnosis:f.verdict,diagnosisDetail:f.detail})}return!0}};var gr={renderTextElement(e,r,t,s){let a=this.gl;this.bindFBO(s);let o=r,n=1,i=1;if(e.isBottomTabContent){let u=this.toggleStates.get(e.isBottomTabContent.groupId);if(u){let h=e.isBottomTabContent.containerWidth??e.rect.w*4,f=1+16*1/h*u.pressProgress;n=f,i=f;let b=e.isBottomTabContent.containerCenterX??e.rect.x+e.rect.w/2,m=e.isBottomTabContent.containerCenterY??e.rect.y+e.rect.h/2,g=e.rect.x+e.rect.w/2,T=e.rect.y+e.rect.h/2,p=b+(g-b)*f+u.panelOffset,x=m+(T-m)*f,v=e.rect.w*n,S=e.rect.h*i;o={x:p-v/2,y:x-S/2,w:v,h:S}}}let l=t?.pressProgress??0,d=!1;if(e.clipRect){let u=Math.max(0,Math.round(o.x*this.dpr)),h=Math.max(0,Math.round((this.cssHeight-(o.y+o.h))*this.dpr)),f=Math.min(this.fboW-u,Math.round(o.w*this.dpr)),b=Math.min(this.fboH-h,Math.round(o.h*this.dpr)),m=this.intersectClipScissor(e,u,h,f,b);a.enable(a.SCISSOR_TEST),a.scissor(m.x,m.y,m.w,m.h),d=!0}if(e.isInteractive&&l>.001){let u=e.pressTintColor;a.useProgram(this.tintProgram),a.bindBuffer(a.ARRAY_BUFFER,this.quadBuffer),a.enableVertexAttribArray(this.aPosLocTn),a.vertexAttribPointer(this.aPosLocTn,2,a.FLOAT,!1,0,0),u?a.blendFunc(a.SRC_ALPHA,a.ONE_MINUS_SRC_ALPHA):a.blendFunc(a.SRC_ALPHA,a.ONE),a.uniform2f(this.uTn.uCanvasSize,this.canvas.width,this.canvas.height),a.uniform2f(this.uTn.uOffset,o.x*this.dpr,o.y*this.dpr),a.uniform2f(this.uTn.uSize,o.w*this.dpr,o.h*this.dpr),a.uniform4f(this.uTn.uCornerRadii,0,0,0,0),a.uniform2f(this.uTn.uOriginalSize,o.w*this.dpr,o.h*this.dpr),a.uniform1f(this.uTn.uOriginalCornerRadius,0),a.uniform2f(this.uTn.uLayerScale,1,1),u?a.uniform4f(this.uTn.uColor,u[0],u[1],u[2],.1*l):a.uniform4f(this.uTn.uColor,1,1,1,.1*l),a.drawArrays(a.TRIANGLES,0,6),a.blendFunc(a.SRC_ALPHA,a.ONE_MINUS_SRC_ALPHA)}let c=this.fgTextures.get(e.id);return c&&(a.useProgram(this.foregroundProgram),a.bindBuffer(a.ARRAY_BUFFER,this.quadBuffer),a.enableVertexAttribArray(this.aPosLocFg),a.vertexAttribPointer(this.aPosLocFg,2,a.FLOAT,!1,0,0),a.blendFunc(a.ONE,a.ONE_MINUS_SRC_ALPHA),a.activeTexture(a.TEXTURE0),a.bindTexture(a.TEXTURE_2D,c),a.uniform1i(this.uFg.uTexture,0),a.uniform2f(this.uFg.uCanvasSize,this.canvas.width,this.canvas.height),a.uniform2f(this.uFg.uOffset,o.x*this.dpr,o.y*this.dpr),a.uniform2f(this.uFg.uSize,o.w*this.dpr,o.h*this.dpr),a.uniform4f(this.uFg.uCornerRadii,e.cornerRadius*this.dpr,e.cornerRadius*this.dpr,e.cornerRadius*this.dpr,e.cornerRadius*this.dpr),a.uniform2f(this.uFg.uOriginalSize,e.rect.w*this.dpr,e.rect.h*this.dpr),a.uniform1f(this.uFg.uOriginalCornerRadius,e.cornerRadius*this.dpr),a.uniform2f(this.uFg.uLayerScale,n,i),a.uniform1f(this.uFg.uCornerStyle,this.cornerStyle),a.uniform1f(this.uFg.uUseContinuousSdf,0),a.uniform1f(this.uFg.uAlpha,e.enterProgress!=null?(()=>{let u=e.enterSafeProgress!=null?Math.max(0,Math.min(1,e.enterSafeProgress)):Math.max(0,Math.min(1,e.enterProgress));return pe(u)})():1),a.drawArrays(a.TRIANGLES,0,6),a.blendFunc(a.SRC_ALPHA,a.ONE_MINUS_SRC_ALPHA)),this.perfMonitor.incNonGlass(),this.perfMonitor.incDrawCall(),d&&a.disable(a.SCISSOR_TEST),!0}};var pr={renderProgressiveBlurElement(e,r,t){let s=this.gl,a=e.progressiveBlur;if(!a)return!0;this.bindFBO(t),s.useProgram(this.progressiveBlurProgram),this.setSdfUniforms(this.uPb,this.aPosLocPb,r,e.cornerRadius),s.blendFunc(s.ONE,s.ONE_MINUS_SRC_ALPHA),s.activeTexture(s.TEXTURE0),s.bindTexture(s.TEXTURE_2D,this.wallpaperTexture),s.uniform1i(this.uPb.uBackdrop,0),s.uniform2f(this.uPb.uWallpaperSize,this.wallpaperSize[0],this.wallpaperSize[1]),s.uniform1f(this.uPb.uBlurRadius,a.blurRadius*this.dpr);let o=a.tintColor;return s.uniform4f(this.uPb.uTintColor,o[0],o[1],o[2],o[3]),s.uniform1f(this.uPb.uTintIntensity,a.tintIntensity),s.drawArrays(s.TRIANGLES,0,6),this.perfMonitor.incNonGlass(),this.perfMonitor.incDrawCall(),!0}};function br(e){return{elRefractionHeight:e.refractionHeight,elRefractionAmount:e.refractionAmount,elBlurRadius:e.blurRadius,elHighlightAlpha:e.highlight?e.highlight.alpha:0,elSurfaceAlpha:e.surfaceColor[3],elContentScaleX:1,elContentScaleY:1,useToggleBackdrop:0,useSolidBackdrop:0,solidR:1,solidG:1,solidB:1,solidA:1,trackColorR:0,trackColorG:0,trackColorB:0,trackColorA:0,trackCenterX:0,trackCenterY:0,trackHalfW:0,trackHalfH:0,trackCornerRadius:0,useIndicatorBackdrop:0,containerRectX:0,containerRectY:0,containerHalfW:0,containerHalfH:0,containerCornerRadius:0,indicatorAccentR:0,indicatorAccentG:0,indicatorAccentB:0,indicatorAccentA:0}}function Sr(e,r,t){let{el:s,sx:a,sy:o,sw:n,sh:i,togglePressProgress:l}=r;if(!s.isToggleKnob)return;let d=l;t.elRefractionHeight=s.refractionHeight*d,t.elRefractionAmount=s.refractionAmount*d,t.elBlurRadius=8*(1-d),t.elHighlightAlpha=(s.highlight?.alpha??0)*d,t.elSurfaceAlpha=0;let c=s.isToggleKnob.velocityDivisor===10,u=c?1:.75,h=c?1:.75;if(t.elContentScaleX=2/3+(u-2/3)*d,t.elContentScaleY=0+(h-0)*d,s.isToggleKnob.trackColorOff&&s.isToggleKnob.trackColorOn&&s.isToggleKnob.trackW&&s.isToggleKnob.trackH){let f=e.toggleStates.get(s.isToggleKnob.groupId),b=f?f.fraction:0,m=s.isToggleKnob.trackColorOff,g=s.isToggleKnob.trackColorOn;t.trackColorR=m[0]+(g[0]-m[0])*b,t.trackColorG=m[1]+(g[1]-m[1])*b,t.trackColorB=m[2]+(g[2]-m[2])*b,t.trackColorA=m[3]+(g[3]-m[3])*b;let T=(a+n/2)*e.dpr,p=(o+i/2)*e.dpr,x=s.isToggleKnob.trackOriginalX??s.rect.x,v=s.isToggleKnob.trackOriginalY??s.rect.y,S=s.scroll?v-e.scrollY:v,C=(x+s.isToggleKnob.trackW/2)*e.dpr,M=(S+s.isToggleKnob.trackH/2)*e.dpr,L=2/3+(u-2/3)*d,R=0+(h-0)*d;t.trackCenterX=T+(C-T)*L,t.trackCenterY=p+(M-p)*R;let E=s.isToggleKnob.trackW*e.dpr,F=s.isToggleKnob.trackH*e.dpr;if(t.trackHalfW=E*L*.5,t.trackHalfH=F*R*.5,t.trackCornerRadius=F*.5*Math.min(L,R),t.useToggleBackdrop=1,s.isToggleKnob.solidBackdropColor){let y=s.isToggleKnob.solidBackdropColor;t.solidR=y[0],t.solidG=y[1],t.solidB=y[2],t.solidA=y[3],t.useSolidBackdrop=1}t.elContentScaleX=1,t.elContentScaleY=1}}function xr(e,r,t){let s=e.gl,{el:a,sx:o,sy:n,sw:i,sh:l,togglePressProgress:d}=r;if(!a.isBottomTabIndicator){s.uniform1f(e.uEl.uIndicatorPressProgress,0),s.uniform1f(e.uEl.uIndicatorPanelOffset,0),s.uniform1f(e.uEl.uDpr,e.dpr),s.uniform2f(e.uEl.uContainerCenter,0,0),s.uniform1f(e.uEl.uContainerScale,1),s.uniform1f(e.uEl.uTabContentCount,0),s.uniform2f(e.uEl.uInnerStrokeMaskOffset,1,1),s.uniform2f(e.uEl.uInnerStrokeMaskSize,1,1);return}let c=d;if(t.elRefractionHeight=a.refractionHeight*c,t.elRefractionAmount=a.refractionAmount*c,t.elBlurRadius=0,t.elHighlightAlpha=(a.highlight?.alpha??0)*c,a.isBottomTabIndicator.accentColor&&a.isBottomTabIndicator.containerRect){let v=a.isBottomTabIndicator.accentColor,S=a.isBottomTabIndicator.containerRect;t.indicatorAccentR=v[0],t.indicatorAccentG=v[1],t.indicatorAccentB=v[2],t.indicatorAccentA=1,t.containerRectX=(S.x+S.w/2)*e.dpr,t.containerRectY=(S.y+S.h/2)*e.dpr,t.containerHalfW=S.w/2*e.dpr,t.containerHalfH=S.h/2*e.dpr,t.containerCornerRadius=S.h/2*e.dpr,t.useIndicatorBackdrop=1}let u=e.toggleStates.get(a.isBottomTabIndicator.groupId);s.uniform1f(e.uEl.uIndicatorPressProgress,u?u.pressProgress:0),s.uniform1f(e.uEl.uIndicatorPanelOffset,u?u.panelOffset*e.dpr:0),s.uniform1f(e.uEl.uDpr,e.dpr);let h=a.isBottomTabIndicator.containerCenterX??0,f=a.isBottomTabIndicator.containerCenterY??0,b=a.isBottomTabIndicator.containerWidth??a.rect.w,m=u?1+16*1/b*u.pressProgress:1;s.uniform2f(e.uEl.uContainerCenter,h*e.dpr,f*e.dpr),s.uniform1f(e.uEl.uContainerScale,m);let g=a.isBottomTabIndicator.tabContentIds??[],T=a.isBottomTabIndicator.tabContentRects??[],p=Math.min(g.length,T.length,8),x=0;for(let v=0;v<8;v++)if(v<p){let S=e.fgTextures.get(g[v]);if(S){s.activeTexture(s.TEXTURE3+x),s.bindTexture(s.TEXTURE_2D,S),s.uniform1i(e.uEl[`uTabContentTex${x}`],3+x);let C=T[v];s.uniform4f(e.uEl[`uTabContentRects[${x}]`],(C.x+C.w/2)*e.dpr,(C.y+C.h/2)*e.dpr,C.w/2*e.dpr,C.h/2*e.dpr),x++}}for(let v=x;v<8;v++)s.uniform4f(e.uEl[`uTabContentRects[${v}]`],0,0,0,0);s.uniform1f(e.uEl.uTabContentCount,x),e.tabsBackdropTex&&(s.activeTexture(s.TEXTURE11),s.bindTexture(s.TEXTURE_2D,e.tabsBackdropTex),s.uniform1i(e.uEl.uTabsGlassLayer,11)),us(e,t)}function us(e,r){let t=e.gl,s=2*r.containerHalfW,a=2*r.containerHalfH,o=r.containerCornerRadius,n=Math.min(.5*e.dpr,Math.min(s,a)*.5),i=Math.max(1,Math.ceil(n)*2),l=Math.max(0,.25*e.dpr),d=Math.ceil(i)+4,c=Math.max(1,Math.ceil(s+2*d)),u=Math.max(1,Math.ceil(a+2*d)),h=window.devicePixelRatio||1,f=Math.min(2,Math.max(1,Math.floor(h/e.dpr))),b=c*f,m=u*f,g=["inner-rr",s.toFixed(3),a.toFixed(3),o.toFixed(3),i,l.toFixed(3),d,c,u,`ss${f}`].join(":"),T=e.strokeMaskCache.get(g);if(!T){let p=document.createElement("canvas");p.width=b,p.height=m;let x=p.getContext("2d",{alpha:!0});if(!x)throw new Error("2D canvas not supported");let v=t.createTexture();if(!v)throw new Error("WebGL texture allocation failed");if(T={tex:v,canvas:p,ctx:x,w:c,h:u,ready:!1},e.strokeMaskCache.set(g,T),e.strokeMaskCache.size>32){let S=e.strokeMaskCache.keys().next().value;if(S&&S!==g){let C=e.strokeMaskCache.get(S);C&&t.deleteTexture(C.tex),e.strokeMaskCache.delete(S)}}}if(!T.ready){let p=T.ctx;p.clearRect(0,0,b,m),p.save(),p.scale(f,f),p.translate(d,d);let x=Math.min(o,s/2,a/2),v=new Path2D;v.moveTo(x,0),v.lineTo(s-x,0),v.arcTo(s,0,s,x,x),v.lineTo(s,a-x),v.arcTo(s,a,s-x,a,x),v.lineTo(x,a),v.arcTo(0,a,0,a-x,x),v.lineTo(0,x),v.arcTo(0,0,x,0,x),v.closePath(),p.clip(v),p.lineWidth=i,p.strokeStyle="rgba(255,255,255,1)",p.lineJoin="round",p.lineCap="round",p.filter=l>.01?`blur(${l}px)`:"none",p.stroke(v),p.filter="none",p.restore(),t.bindTexture(t.TEXTURE_2D,T.tex),t.pixelStorei(t.UNPACK_FLIP_Y_WEBGL,!1),t.texImage2D(t.TEXTURE_2D,0,t.RGBA,t.RGBA,t.UNSIGNED_BYTE,T.canvas),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),T.ready=!0}t.activeTexture(t.TEXTURE12),t.bindTexture(t.TEXTURE_2D,T.tex),t.uniform1i(e.uEl.uInnerStrokeMask,12),t.uniform2f(e.uEl.uInnerStrokeMaskOffset,d,d),t.uniform2f(e.uEl.uInnerStrokeMaskSize,T.w,T.h)}var Tr={renderGlassElementPass(e,r,t){let s=this.gl,{el:a,sx:o,sy:n,sw:i,sh:l,radii:d,togglePressProgress:c,layerScale:u}=e;if(s.useProgram(this.elementProgram),s.bindBuffer(s.ARRAY_BUFFER,this.quadBuffer),s.enableVertexAttribArray(this.aPosLocEl),s.vertexAttribPointer(this.aPosLocEl,2,s.FLOAT,!1,0,0),s.blendFuncSeparate(s.ONE,s.ONE_MINUS_SRC_ALPHA,s.ONE,s.ONE_MINUS_SRC_ALPHA),s.activeTexture(s.TEXTURE0),s.bindTexture(s.TEXTURE_2D,r),s.uniform1i(this.uEl.uBackdrop,0),this.wallpaperTexture&&(s.activeTexture(s.TEXTURE1),s.bindTexture(s.TEXTURE_2D,this.wallpaperTexture),s.uniform1i(this.uEl.uWallpaperSampler,1)),s.uniform2f(this.uEl.uCanvasSize,this.canvas.width,this.canvas.height),s.uniform2f(this.uEl.uWallpaperSize,this.wallpaperSize[0],this.wallpaperSize[1]),s.uniform2f(this.uEl.uElementOffset,o*this.dpr,n*this.dpr),s.uniform2f(this.uEl.uElementSize,i*this.dpr,l*this.dpr),t){let v=this.canvas.width,S=this.canvas.height,C=t.x/v,M=(t.x+t.w)/v,L=1-t.y/S,R=1-(t.y+t.h)/S;s.uniform4f(this.uEl.uBackdropBbox,C,R,M-C,L-R)}else s.uniform4f(this.uEl.uBackdropBbox,0,0,1,1);s.uniform4f(this.uEl.uCornerRadii,d[0]*this.dpr,d[1]*this.dpr,d[2]*this.dpr,d[3]*this.dpr),s.uniform2f(this.uEl.uOriginalSize,e.origW*this.dpr,e.origH*this.dpr),s.uniform1f(this.uEl.uOriginalCornerRadius,e.origCornerRadius*this.dpr),s.uniform2f(this.uEl.uLayerScale,e.layerScaleX,e.layerScaleY),s.uniform1f(this.uEl.uElementRotation,a.elementRotation??0),s.uniform1f(this.uEl.uUsePerElementFbo,e.usePerElementFbo?1:0),e.usePerElementFbo&&(s.uniform2f(this.uEl.uSceneRectOffset,e.sceneRectOffsetX,e.sceneRectOffsetY),s.uniform2f(this.uEl.uElFboSize,e.elFboW,e.elFboH));let h=br(a);Sr(this,e,h),xr(this,e,h),s.uniform1f(this.uEl.uUseToggleBackdrop,h.useToggleBackdrop),s.uniform1f(this.uEl.uUseSolidBackdrop,h.useSolidBackdrop),s.uniform4f(this.uEl.uSolidBackdropColor,h.solidR,h.solidG,h.solidB,h.solidA),s.uniform4f(this.uEl.uTrackColor,h.trackColorR,h.trackColorG,h.trackColorB,h.trackColorA),s.uniform4f(this.uEl.uTrackRect,h.trackCenterX,h.trackCenterY,h.trackHalfW,h.trackHalfH),s.uniform1f(this.uEl.uTrackCornerRadius,h.trackCornerRadius),s.uniform1f(this.uEl.uIndicatorBackdrop,h.useIndicatorBackdrop),s.uniform4f(this.uEl.uContainerRect,h.containerRectX,h.containerRectY,h.containerHalfW,h.containerHalfH),s.uniform1f(this.uEl.uContainerCornerRadius,h.containerCornerRadius),s.uniform4f(this.uEl.uIndicatorAccent,h.indicatorAccentR,h.indicatorAccentG,h.indicatorAccentB,h.indicatorAccentA),s.uniform1f(this.uEl.uInsetPx,4*this.dpr);let f=this.quickToggles.refraction?h.elRefractionHeight:0,b=this.quickToggles.refraction?h.elRefractionAmount:0;s.uniform1f(this.uEl.uRefractionHeight,f*this.dpr),s.uniform1f(this.uEl.uRefractionAmount,b*this.dpr),s.uniform1f(this.uEl.uDepthEffect,a.depthEffect?1:0),s.uniform1f(this.uEl.uChromaticAberration,a.chromaticAberration&&this.quickToggles.chromatic?1:0);let m=a.sampleWallpaper||e.independent,g=Me(a,e)?0:h.elBlurRadius;if(s.uniform1f(this.uEl.uBlurRadius,g*u*this.dpr),s.uniform1f(this.uEl.uSaturation,a.saturation),s.uniform1f(this.uEl.uBrightness,a.brightness),s.uniform1f(this.uEl.uContrast,a.contrast),s.uniform1f(this.uEl.uContentScaleX,h.elContentScaleX),s.uniform1f(this.uEl.uContentScaleY,h.elContentScaleY),s.uniform4f(this.uEl.uTintColor,a.tintColor[0],a.tintColor[1],a.tintColor[2],a.tintColor[3]),s.uniform4f(this.uEl.uSurfaceColor,a.surfaceColor[0],a.surfaceColor[1],a.surfaceColor[2],h.elSurfaceAlpha),a.highlight){s.uniform3f(this.uEl.uHighlightColor,a.highlight.color[0],a.highlight.color[1],a.highlight.color[2]),s.uniform1f(this.uEl.uHighlightAngle,a.highlight.angle),s.uniform1f(this.uEl.uHighlightFalloff,a.highlight.falloff),s.uniform1f(this.uEl.uHighlightAlpha,h.elHighlightAlpha),s.uniform1f(this.uEl.uHighlightMode,a.highlight.mode);let v=Math.min(e.origW,e.origH)*this.dpr,S=Math.min(a.highlight.widthDp*this.dpr,v*.5),C=(a.highlight.blurRadiusDp??a.highlight.widthDp/2)*this.dpr,M=a.highlight.aa!==!1?Math.ceil(S)*2:Math.max(1,S)*2;s.uniform1f(this.uEl.uHighlightStrokeWidth,M),s.uniform1f(this.uEl.uHighlightBlur,C)}else s.uniform1f(this.uEl.uHighlightAlpha,0),s.uniform1f(this.uEl.uHighlightMode,0),s.uniform1f(this.uEl.uHighlightStrokeWidth,0),s.uniform1f(this.uEl.uHighlightBlur,0);let T=a.isSdfTexture?.textureSource??"clock",p=T==="text"?this.textSdfTexture:this.sdfTexture,x=T==="text"?this.textSdfTextureSize:this.sdfTextureSize;if(a.isSdfTexture&&p){s.activeTexture(s.TEXTURE2),s.bindTexture(s.TEXTURE_2D,p),s.uniform1i(this.uEl.uSdfTexSampler,2),s.uniform1f(this.uEl.uUseSdfTexture,1),s.uniform2f(this.uEl.uSdfTexSize,x[0],x[1]),s.uniform1f(this.uEl.uSdfLightAngle,a.useGravityAngle?this.gravityAngle*180/Math.PI:a.isSdfTexture.lightAngle),s.uniform1f(this.uEl.uRefractionHeight,(this.quickToggles.refraction?a.isSdfTexture.refractionHeight:0)*this.dpr),s.uniform1f(this.uEl.uSdfHighlightScale,a.isSdfTexture.highlightScale??1.5),s.uniform1f(this.uEl.uSdfBevelEnabled,a.isSdfTexture.bevelEnabled??!0?1:0),s.uniform1f(this.uEl.uSdfGlassTintHue,a.isSdfTexture.glassTintHue??0),s.uniform1f(this.uEl.uSdfGlassTintEnabled,a.isSdfTexture.glassTintEnabled??!1?1:0),s.uniform1f(this.uEl.uSdfGlassTintMix,a.isSdfTexture.glassTintMix??0),s.uniform1f(this.uEl.uSdfGlassTintStrength,a.isSdfTexture.glassTintStrength??.85),s.uniform1f(this.uEl.uSdfGlassTintSaturation,a.isSdfTexture.glassTintSaturation??1),s.uniform1f(this.uEl.uSdfGlassTintLightness,a.isSdfTexture.glassTintLightness??1),s.uniform1f(this.uEl.uSdfEdgeMatteEnabled,a.isSdfTexture.edgeMatteEnabled??!1?1:0),s.uniform1f(this.uEl.uSdfEdgeMatteTargets,a.isSdfTexture.edgeMatteTargets??7);let v=a.isSdfTexture.edgeMatteBevelParams??[1,0];s.uniform2f(this.uEl.uSdfEdgeMatteBevelParams,v[0],v[1]);let S=a.isSdfTexture.edgeMatteTintParams??[1,0];s.uniform2f(this.uEl.uSdfEdgeMatteTintParams,S[0],S[1]);let C=a.isSdfTexture.edgeMatteBaseParams??[1,0];s.uniform2f(this.uEl.uSdfEdgeMatteBaseParams,C[0],C[1]);let M=a.isSdfTexture.edgeMatteBrightenParams??[1,0];s.uniform2f(this.uEl.uSdfEdgeMatteBrightenParams,M[0],M[1]),s.uniform1f(this.uEl.uSdfEdgeMatteBevelStrength,a.isSdfTexture.edgeMatteBevelStrength??1),s.uniform1f(this.uEl.uSdfEdgeMatteTintStrength,a.isSdfTexture.edgeMatteTintStrength??1),s.uniform1f(this.uEl.uSdfEdgeMatteBaseStrength,a.isSdfTexture.edgeMatteBaseStrength??1),s.uniform1f(this.uEl.uSdfEdgeMatteBrightenStrength,a.isSdfTexture.edgeMatteBrightenStrength??1),s.uniform1f(this.uEl.uSdfDebugMode,a.isSdfTexture.debugMode?1:0),s.uniform1f(this.uEl.uSdfAaMin,a.isSdfTexture.aaMin??.5)}else s.uniform1f(this.uEl.uUseSdfTexture,0),s.uniform1f(this.uEl.uSdfHighlightScale,1.5),s.uniform1f(this.uEl.uSdfBevelEnabled,1),s.uniform1f(this.uEl.uSdfGlassTintHue,0),s.uniform1f(this.uEl.uSdfGlassTintEnabled,0),s.uniform1f(this.uEl.uSdfGlassTintMix,0),s.uniform1f(this.uEl.uSdfGlassTintStrength,.85),s.uniform1f(this.uEl.uSdfGlassTintSaturation,1),s.uniform1f(this.uEl.uSdfGlassTintLightness,1),s.uniform1f(this.uEl.uSdfEdgeMatteEnabled,0),s.uniform1f(this.uEl.uSdfEdgeMatteTargets,7),s.uniform2f(this.uEl.uSdfEdgeMatteBevelParams,1,0),s.uniform2f(this.uEl.uSdfEdgeMatteTintParams,1,0),s.uniform2f(this.uEl.uSdfEdgeMatteBaseParams,1,0),s.uniform2f(this.uEl.uSdfEdgeMatteBrightenParams,1,0),s.uniform1f(this.uEl.uSdfEdgeMatteBevelStrength,1),s.uniform1f(this.uEl.uSdfEdgeMatteTintStrength,1),s.uniform1f(this.uEl.uSdfEdgeMatteBaseStrength,1),s.uniform1f(this.uEl.uSdfEdgeMatteBrightenStrength,1),s.uniform1f(this.uEl.uSdfDebugMode,0),s.uniform1f(this.uEl.uSdfAaMin,.5),this.dummyTex&&(s.activeTexture(s.TEXTURE2),s.bindTexture(s.TEXTURE_2D,this.dummyTex));a.useContinuousSdf&&this.continuousSdfTexture?(s.activeTexture(s.TEXTURE2),s.bindTexture(s.TEXTURE_2D,this.continuousSdfTexture),s.uniform1i(this.uEl.uContinuousSdf,2),s.uniform1f(this.uEl.uUseContinuousSdf,1),s.uniform2f(this.uEl.uContinuousSdfTexSize,this.continuousSdfTexSize[0],this.continuousSdfTexSize[1]),s.uniform2f(this.uEl.uContinuousSdfElementSize,e.origW*this.dpr,e.origH*this.dpr)):(s.uniform1f(this.uEl.uUseContinuousSdf,0),this.dummyTex&&!a.isSdfTexture&&(s.activeTexture(s.TEXTURE2),s.bindTexture(s.TEXTURE_2D,this.dummyTex))),s.uniform1f(this.uEl.uNoContinuousSdfInRefraction,a.useContinuousSdf&&!this.noContinuousSdf?0:1),s.uniform1f(this.uEl.uEnterAlpha,e.enterAlpha),s.uniform1f(this.uEl.uCornerStyle,this.cornerStyle),a.isMagnifier?(s.uniform1f(this.uEl.uUseMagnifier,1),s.uniform1f(this.uEl.uMagnifierZoom,a.isMagnifier.zoom),s.uniform1f(this.uEl.uMagnifierOffsetY,a.isMagnifier.sampleOffsetY*this.dpr)):s.uniform1f(this.uEl.uUseMagnifier,0),s.uniform1f(this.uEl.uSkipColorControls,a.backdropFbo&&Me(a,e)?1:0),s.uniform1f(this.uEl.uSampleWallpaper,m?1:0),a.scrimColor?s.uniform4f(this.uEl.uScrimColor,a.scrimColor[0],a.scrimColor[1],a.scrimColor[2],a.scrimColor[3]):s.uniform4f(this.uEl.uScrimColor,0,0,0,0),s.drawArrays(s.TRIANGLES,0,6),e.elHighlightAlpha=h.elHighlightAlpha}};function cs(e,r,t,s){if(s){let n=new OffscreenCanvas(1,1).getContext("2d");return Se(n,e,r,t)}let a=new Path2D;if(typeof a.roundRect=="function")a.roundRect(0,0,e,r,t);else{let o=Math.min(t,e/2,r/2);a.moveTo(o,0),a.lineTo(e-o,0),a.arcTo(e,0,e,o,o),a.lineTo(e,r-o),a.arcTo(e,r,e-o,r,o),a.lineTo(o,r),a.arcTo(0,r,0,r-o,o),a.lineTo(0,o),a.arcTo(0,0,o,0,o),a.closePath()}return a}function vr(e,r){let t=new OffscreenCanvas(e,r),s=t.getContext("2d",{alpha:!0});return{canvas:t,ctx:s}}function Cr(e){let{w:r,h:t,radius:s,offsetX:a,offsetY:o,blurSigma:n,margin:i,useG2:l,supersample:d}=e,c=Math.max(1,Math.ceil(r+2*i)),u=Math.max(1,Math.ceil(t+2*i)),h=c*d,f=u*d,{canvas:b,ctx:m}=vr(h,f),{canvas:g,ctx:T}=vr(h,f);m.save(),m.scale(d,d),m.translate(i,i);let p=cs(r,t,s,l);return m.clip(p),m.globalCompositeOperation="source-over",m.fillStyle="white",m.fill(p),m.globalCompositeOperation="destination-out",m.save(),m.translate(a,o),m.fill(p),m.restore(),m.globalCompositeOperation="source-over",m.restore(),n>.01?T.filter=`blur(${n*d}px)`:T.filter="none",T.drawImage(b,0,0),T.filter="none",{canvas:g,maskW:c,maskH:u,margin:i}}function Er(e,r){return["is",e,r.useG2?"g2":"rr",r.w.toFixed(3),r.h.toFixed(3),r.radius.toFixed(3),r.offsetX.toFixed(3),r.offsetY.toFixed(3),r.blurSigma.toFixed(3),r.margin,Math.ceil(r.w+2*r.margin),Math.ceil(r.h+2*r.margin),`ss${r.supersample}`].join(":")}function Rr(e,r,t,s,a){let o=e.get(t);if(o)return o;let n=r.createTexture();if(!n)throw new Error("WebGL texture allocation failed");if(o={tex:n,w:s,h:a,ready:!1},e.set(t,o),e.size>32){let i=e.keys().next().value;if(i&&i!==t){let l=e.get(i);l&&r.deleteTexture(l.tex),e.delete(i)}}return o}function yr(e,r,t){e.bindTexture(e.TEXTURE_2D,r.tex),e.pixelStorei(e.UNPACK_FLIP_Y_WEBGL,!1),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,t.canvas),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),r.ready=!0}function Ar(e,r){for(let t of r.values())e.deleteTexture(t.tex);r.clear()}function wr(e,r){let t=e.gl,{el:s,sx:a,sy:o,sw:n,sh:i,radii:l,togglePressProgress:d}=r;if(!s.innerShadow||!e.quickToggles.innershadow)return;let c=r.origW*e.dpr,u=r.origH*e.dpr,h=r.origCornerRadius*e.dpr,f=r.layerScaleX,b=r.layerScaleY;m(e,r,s.innerShadow,0);function m(g,T,p,x){let v=T.el.isToggleKnob||T.el.isBottomTabIndicator?d:1,S=p.alpha*v*T.enterAlpha,C=p.radius*v,M=p.offsetX*v,L=p.offsetY*v;if(S<=.001||C<=.5)return;let R=C*g.dpr,E=Math.ceil(R*3)+2,F=Math.max(1,Math.ceil(c+2*E)),y=Math.max(1,Math.ceil(u+2*E)),U=window.devicePixelRatio||1,w=Math.min(2,Math.max(1,Math.floor(U/g.dpr))),W=!!T.el.useContinuousSdf,k=M*g.dpr,P=L*g.dpr,X={w:c,h:u,radius:h,offsetX:k,offsetY:P,blurSigma:R,margin:E,useG2:W,supersample:w},$=Er(x,X),Y=Rr(g.innerShadowMaskCache,t,$,F,y);if(!Y.ready){let G=Cr(X);yr(t,Y,G)}t.enable(t.BLEND),t.blendFunc(t.ONE,t.ONE_MINUS_SRC_ALPHA),t.useProgram(g.innerShadowMaskCompositeProgram),t.bindBuffer(t.ARRAY_BUFFER,g.quadBuffer),t.enableVertexAttribArray(g.aPosLocIs),t.vertexAttribPointer(g.aPosLocIs,2,t.FLOAT,!1,0,0),t.uniform2f(g.uIs.uCanvasSize,g.canvas.width,g.canvas.height),t.uniform2f(g.uIs.uOffset,a*g.dpr,o*g.dpr),t.uniform2f(g.uIs.uSize,n*g.dpr,i*g.dpr),t.uniform4f(g.uIs.uCornerRadii,l[0]*g.dpr,l[1]*g.dpr,l[2]*g.dpr,l[3]*g.dpr),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,Y.tex),t.uniform1i(g.uIs.uInnerShadowMask,0),t.uniform2f(g.uIs.uMaskOffset,E,E),t.uniform2f(g.uIs.uMaskSize,Y.w,Y.h);let B=p.color??[0,0,0];t.uniform3f(g.uIs.uInnerShadowColor,B[0],B[1],B[2]),t.uniform1f(g.uIs.uInnerShadowAlpha,S),t.uniform2f(g.uIs.uOriginalSize,c,u),t.uniform1f(g.uIs.uOriginalCornerRadius,h),t.uniform2f(g.uIs.uLayerScale,f,b),t.uniform1f(g.uIs.uElementRotation,T.elementRotation),t.drawArrays(t.TRIANGLES,0,6)}}function Fr(e,r){let t=e.gl,{el:s,st:a,isButton:o,p:n,sx:i,sy:l,sw:d,sh:c,radii:u,togglePressProgress:h}=r,f=r.origW*e.dpr,b=r.origH*e.dpr,m=r.origCornerRadius*e.dpr,g=r.layerScaleX,T=r.layerScaleY,p=()=>{s.useContinuousSdf&&e.continuousSdfTexture?(t.activeTexture(t.TEXTURE2),t.bindTexture(t.TEXTURE_2D,e.continuousSdfTexture),t.uniform1i(e.uTn.uContinuousSdf,2),t.uniform1f(e.uTn.uUseContinuousSdf,1),t.uniform2f(e.uTn.uContinuousSdfTexSize,e.continuousSdfTexSize[0],e.continuousSdfTexSize[1]),t.uniform2f(e.uTn.uContinuousSdfElementSize,r.origW*e.dpr,r.origH*e.dpr)):t.uniform1f(e.uTn.uUseContinuousSdf,0)},x=!!s.isBottomTabContainer,v=o?n:x?h:0;if(o&&s.isInteractive&&a&&n>.001||x&&h>.001){t.useProgram(e.tintProgram),t.bindBuffer(t.ARRAY_BUFFER,e.quadBuffer),t.enableVertexAttribArray(e.aPosLocTn),t.vertexAttribPointer(e.aPosLocTn,2,t.FLOAT,!1,0,0),t.blendFunc(t.SRC_ALPHA,t.ONE),t.uniform2f(e.uTn.uCanvasSize,e.canvas.width,e.canvas.height),t.uniform2f(e.uTn.uOffset,i*e.dpr,l*e.dpr),t.uniform2f(e.uTn.uSize,d*e.dpr,c*e.dpr),t.uniform4f(e.uTn.uCornerRadii,u[0]*e.dpr,u[1]*e.dpr,u[2]*e.dpr,u[3]*e.dpr),t.uniform2f(e.uTn.uOriginalSize,f,b),t.uniform1f(e.uTn.uOriginalCornerRadius,m),t.uniform2f(e.uTn.uLayerScale,g,T),t.uniform1f(e.uTn.uElementRotation,r.elementRotation),t.uniform1f(e.uTn.uCornerStyle,e.cornerStyle),p(),t.uniform4f(e.uTn.uColor,1,1,1,.08*v),t.drawArrays(t.TRIANGLES,0,6),t.useProgram(e.highlightProgram),t.bindBuffer(t.ARRAY_BUFFER,e.quadBuffer),t.enableVertexAttribArray(e.aPosLocHl),t.vertexAttribPointer(e.aPosLocHl,2,t.FLOAT,!1,0,0),t.blendFunc(t.ONE,t.ONE),t.uniform2f(e.uHl.uCanvasSize,e.canvas.width,e.canvas.height),t.uniform2f(e.uHl.uOffset,i*e.dpr,l*e.dpr),t.uniform2f(e.uHl.uSize,d*e.dpr,c*e.dpr),t.uniform4f(e.uHl.uCornerRadii,u[0]*e.dpr,u[1]*e.dpr,u[2]*e.dpr,u[3]*e.dpr),t.uniform2f(e.uHl.uOriginalSize,f,b),t.uniform1f(e.uHl.uOriginalCornerRadius,m),t.uniform2f(e.uHl.uLayerScale,g,T),t.uniform1f(e.uHl.uElementRotation,r.elementRotation),t.uniform1f(e.uHl.uCornerStyle,e.cornerStyle),t.uniform4f(e.uHl.uColor,1,1,1,.15*v);let S=Math.min(d,c)*e.dpr;t.uniform1f(e.uHl.uRadius,S*1.5);let C,M;if(x){let L=e.toggleStates.get(s.isBottomTabContainer.groupId),R=s.isBottomTabContainer.tabsCount??4,E=s.rect.w/R,y=((L?L.fraction:0)+.5)*E,U=d/s.rect.w;C=Math.max(0,Math.min(d,y*U))*e.dpr,M=c/2*e.dpr}else C=Math.max(0,Math.min(d,a.dragX*r.layerScaleX))*e.dpr,M=Math.max(0,Math.min(c,a.dragY*r.layerScaleY))*e.dpr;t.uniform2f(e.uHl.uPosition,C,M),t.drawArrays(t.TRIANGLES,0,6),t.blendFunc(t.SRC_ALPHA,t.ONE_MINUS_SRC_ALPHA)}if(s.isToggleKnob&&h<.999){let S=1*(1-h);t.useProgram(e.tintProgram),t.bindBuffer(t.ARRAY_BUFFER,e.quadBuffer),t.enableVertexAttribArray(e.aPosLocTn),t.vertexAttribPointer(e.aPosLocTn,2,t.FLOAT,!1,0,0),t.blendFunc(t.SRC_ALPHA,t.ONE_MINUS_SRC_ALPHA),t.uniform2f(e.uTn.uCanvasSize,e.canvas.width,e.canvas.height),t.uniform2f(e.uTn.uOffset,i*e.dpr,l*e.dpr),t.uniform2f(e.uTn.uSize,d*e.dpr,c*e.dpr),t.uniform4f(e.uTn.uCornerRadii,u[0]*e.dpr,u[1]*e.dpr,u[2]*e.dpr,u[3]*e.dpr),t.uniform2f(e.uTn.uOriginalSize,f,b),t.uniform1f(e.uTn.uOriginalCornerRadius,m),t.uniform2f(e.uTn.uLayerScale,g,T),t.uniform1f(e.uTn.uElementRotation,r.elementRotation),t.uniform1f(e.uTn.uCornerStyle,e.cornerStyle),p(),t.uniform4f(e.uTn.uColor,1,1,1,S),t.drawArrays(t.TRIANGLES,0,6)}if(s.isBottomTabIndicator&&s.isBottomTabIndicator.dimColor){let S=s.isBottomTabIndicator.dimColor,C=h;t.useProgram(e.tintProgram),t.bindBuffer(t.ARRAY_BUFFER,e.quadBuffer),t.enableVertexAttribArray(e.aPosLocTn),t.vertexAttribPointer(e.aPosLocTn,2,t.FLOAT,!1,0,0),t.blendFunc(t.SRC_ALPHA,t.ONE_MINUS_SRC_ALPHA),t.uniform2f(e.uTn.uCanvasSize,e.canvas.width,e.canvas.height),t.uniform2f(e.uTn.uOffset,i*e.dpr,l*e.dpr),t.uniform2f(e.uTn.uSize,d*e.dpr,c*e.dpr),t.uniform4f(e.uTn.uCornerRadii,u[0]*e.dpr,u[1]*e.dpr,u[2]*e.dpr,u[3]*e.dpr),t.uniform2f(e.uTn.uOriginalSize,f,b),t.uniform1f(e.uTn.uOriginalCornerRadius,m),t.uniform2f(e.uTn.uLayerScale,g,T),t.uniform1f(e.uTn.uElementRotation,r.elementRotation),t.uniform1f(e.uTn.uCornerStyle,e.cornerStyle),p(),t.uniform4f(e.uTn.uColor,S[0],S[1],S[2],.1*(1-C)),t.drawArrays(t.TRIANGLES,0,6),t.uniform4f(e.uTn.uColor,0,0,0,.03*C),t.drawArrays(t.TRIANGLES,0,6),t.blendFunc(t.SRC_ALPHA,t.ONE_MINUS_SRC_ALPHA)}}function Mr(e,r){let t=e.gl,{el:s,sx:a,sy:o,sw:n,sh:i,radii:l,togglePressProgress:d,elHighlightAlpha:c}=r;if(!s.highlight||s.highlight.alpha<=.001||!e.quickToggles.highlight)return;let u=r.origW*e.dpr,h=r.origH*e.dpr,f=r.origCornerRadius*e.dpr,b=r.layerScaleX,m=r.layerScaleY,g=s.isToggleKnob||s.isBottomTabIndicator?c:s.highlight.alpha,T=s.highlight.mode===1?.38:1,p=g*r.enterAlpha*T;if(p<=.001)return;let x=Math.min(s.highlight.widthDp*e.dpr,Math.min(u,h)*.5),v=s.highlight.aa!==!1?Math.max(1,Math.ceil(x)*2):Math.max(1,Math.round(x)*2),S=Math.max(0,(s.highlight.blurRadiusDp??s.highlight.widthDp/2)*e.dpr),C=Math.ceil(v)+4,M=Math.max(1,Math.ceil(u+2*C)),L=Math.max(1,Math.ceil(h+2*C)),R=window.devicePixelRatio||1,E=Math.min(2,Math.max(1,Math.floor(R/e.dpr))),F=M*E,y=L*E,U=!!s.useContinuousSdf,w=[U?"g2":"rr",u.toFixed(3),h.toFixed(3),f.toFixed(3),v,S.toFixed(3),C,M,L,`ss${E}`].join(":"),W=e.strokeMaskCache.get(w);if(!W){let k=document.createElement("canvas");k.width=F,k.height=y;let P=k.getContext("2d",{alpha:!0});if(!P)throw new Error("2D canvas not supported");let X=t.createTexture();if(!X)throw new Error("WebGL texture allocation failed");if(W={tex:X,canvas:k,ctx:P,w:M,h:L,ready:!1},e.strokeMaskCache.set(w,W),e.strokeMaskCache.size>32){let $=e.strokeMaskCache.keys().next().value;if($&&$!==w){let Y=e.strokeMaskCache.get($);Y&&t.deleteTexture(Y.tex),e.strokeMaskCache.delete($)}}}if(!W.ready){let k=W.ctx;k.clearRect(0,0,F,y),k.save(),k.scale(E,E),k.translate(C,C);let P;if(U)P=Se(k,u,h,f);else{P=new Path2D;let X=Math.min(f,u/2,h/2);P.moveTo(X,0),P.lineTo(u-X,0),P.arcTo(u,0,u,X,X),P.lineTo(u,h-X),P.arcTo(u,h,u-X,h,X),P.lineTo(X,h),P.arcTo(0,h,0,h-X,X),P.lineTo(0,X),P.arcTo(0,0,X,0,X),P.closePath()}k.clip(P),k.lineWidth=v,k.strokeStyle="rgba(255,255,255,1)",k.lineJoin="round",k.lineCap="round",k.filter=S>.01?`blur(${S}px)`:"none",k.stroke(P),k.filter="none",k.restore(),t.bindTexture(t.TEXTURE_2D,W.tex),t.pixelStorei(t.UNPACK_FLIP_Y_WEBGL,!1),t.texImage2D(t.TEXTURE_2D,0,t.RGBA,t.RGBA,t.UNSIGNED_BYTE,W.canvas),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),W.ready=!0}t.enable(t.BLEND),s.highlight.mode===1?t.blendFunc(t.ONE,t.ONE_MINUS_SRC_ALPHA):t.blendFunc(t.ONE,t.ONE),t.useProgram(e.strokeMaskCompositeProgram),t.bindBuffer(t.ARRAY_BUFFER,e.quadBuffer),t.enableVertexAttribArray(e.aPosLocSm),t.vertexAttribPointer(e.aPosLocSm,2,t.FLOAT,!1,0,0),t.uniform2f(e.uSm.uCanvasSize,e.canvas.width,e.canvas.height),t.uniform2f(e.uSm.uOffset,a*e.dpr,o*e.dpr),t.uniform2f(e.uSm.uSize,n*e.dpr,i*e.dpr),t.uniform4f(e.uSm.uCornerRadii,l[0]*e.dpr,l[1]*e.dpr,l[2]*e.dpr,l[3]*e.dpr),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,W.tex),t.uniform1i(e.uSm.uStrokeMask,0),t.uniform2f(e.uSm.uMaskOffset,C,C),t.uniform2f(e.uSm.uMaskSize,W.w,W.h),t.uniform4f(e.uSm.uHighlightColor,s.highlight.color[0],s.highlight.color[1],s.highlight.color[2],1),t.uniform1f(e.uSm.uHighlightAngle,s.useGravityAngle?e.gravityAngle:s.highlight.angle),t.uniform1f(e.uSm.uHighlightFalloff,s.highlight.falloff),t.uniform1f(e.uSm.uHighlightAlpha,p),t.uniform1f(e.uSm.uHighlightMode,s.highlight.mode),t.uniform2f(e.uSm.uOriginalSize,u,h),t.uniform1f(e.uSm.uOriginalCornerRadius,f),t.uniform2f(e.uSm.uLayerScale,b,m),t.uniform1f(e.uSm.uElementRotation,r.elementRotation),t.drawArrays(t.TRIANGLES,0,6),t.blendFunc(t.SRC_ALPHA,t.ONE_MINUS_SRC_ALPHA)}var kr={renderGlassPostPasses(e){let r=this.gl,{el:t,st:s,isButton:a,p:o,sx:n,sy:i,sw:l,sh:d,radii:c}=e,u=e.origW*this.dpr,h=e.origH*this.dpr,f=e.origCornerRadius*this.dpr,b=e.layerScaleX,m=e.layerScaleY;if(wr(this,e),Fr(this,e),a&&(t.label||t.icon)){let g=this.fgTextures.get(t.id);g&&(r.useProgram(this.foregroundProgram),r.bindBuffer(r.ARRAY_BUFFER,this.quadBuffer),r.enableVertexAttribArray(this.aPosLocFg),r.vertexAttribPointer(this.aPosLocFg,2,r.FLOAT,!1,0,0),r.blendFunc(r.ONE,r.ONE_MINUS_SRC_ALPHA),r.activeTexture(r.TEXTURE0),r.bindTexture(r.TEXTURE_2D,g),r.uniform1i(this.uFg.uTexture,0),r.uniform2f(this.uFg.uCanvasSize,this.canvas.width,this.canvas.height),r.uniform2f(this.uFg.uOffset,n*this.dpr,i*this.dpr),r.uniform2f(this.uFg.uSize,l*this.dpr,d*this.dpr),r.uniform4f(this.uFg.uCornerRadii,c[0]*this.dpr,c[1]*this.dpr,c[2]*this.dpr,c[3]*this.dpr),r.uniform2f(this.uFg.uOriginalSize,u,h),r.uniform1f(this.uFg.uOriginalCornerRadius,f),r.uniform2f(this.uFg.uLayerScale,b,m),r.uniform1f(this.uFg.uCornerStyle,this.cornerStyle),t.useContinuousSdf&&this.continuousSdfTexture?(r.activeTexture(r.TEXTURE2),r.bindTexture(r.TEXTURE_2D,this.continuousSdfTexture),r.uniform1i(this.uFg.uContinuousSdf,2),r.uniform1f(this.uFg.uUseContinuousSdf,1),r.uniform2f(this.uFg.uContinuousSdfTexSize,this.continuousSdfTexSize[0],this.continuousSdfTexSize[1]),r.uniform2f(this.uFg.uContinuousSdfElementSize,e.origW*this.dpr,e.origH*this.dpr)):r.uniform1f(this.uFg.uUseContinuousSdf,0),r.uniform1f(this.uFg.uAlpha,1-.15*o),r.drawArrays(r.TRIANGLES,0,6),r.blendFunc(r.SRC_ALPHA,r.ONE_MINUS_SRC_ALPHA))}Mr(this,e)}};var Br={markElementDirty(e){this.dirtyElementIds.add(e);let r=this.elFboCache.get(e);if(r&&(r.valid=!1),this.showDirtyMarkers){let s=(new Error().stack??"").split(`
`),a="unknown";for(let o=2;o<s.length;o++){let n=s[o].trim();if(!n||n.includes("markElementDirty")||n.includes("markGroupDirty")||n.includes("markAllDirty"))continue;let i=n.match(/at\s+(\S+)\s+\(/);a=i?i[1]:n.slice(0,60);break}this.debugDirtySourceLog.push({id:e,source:a})}},markAllDirty(){this.allDirty=!0,this.dirtyElementIds.clear();for(let e of this.elFboCache.values())e.valid=!1},markGroupDirty(e){for(let r of this.buttonConfigs)(r.isToggleKnob?.groupId===e||r.isToggleTrack?.groupId===e||r.isSliderFill?.groupId===e||r.isBottomTabContainer?.groupId===e||r.isBottomTabContent?.groupId===e||r.isBottomTabIndicator?.groupId===e)&&this.markElementDirty(r.id)},markGravityDirty(){for(let e of this.buttonConfigs)e.useGravityAngle&&this.markElementDirty(e.id)},hasDirtyElements(){return this.allDirty||this.dirtyElementIds.size>0},deleteElFboCacheEntry(e){let r=this.elFboCache.get(e);if(!r)return;let t=this.gl;t.deleteFramebuffer(r.fb),t.deleteTexture(r.tex),this.elFboCache.delete(e)}};function ds(e){let{pixels:r,dpr:t}=e,s=r.length;if(s<4)return{edgeIdx:0,edgeOffsetCss:0,transitionHalfW:0,rgbInside:0,rgbOutside:0,minRgbInTransition:0,blackFringeDetected:!1,hasNearBlackPx:!1,canvasOpaque:!0,verdict:"Scan too short (element not found or off-screen)."};let a=new Float32Array(s),o=0;for(let E=0;E<s;E++){let F=r[E];a[E]=.299*F.r+.587*F.g+.114*F.b,F.a>=250&&o++}let n=o>s*.9,i=0,l=Math.floor(s/2);for(let E=2;E<s-2;E++){let F=Math.abs(a[E+1]-a[E-1]);F>i&&(i=F,l=E)}let d=r[l].offset,c=Math.max(3,Math.floor(s/8)),u=Math.max(0,l-c),h=Math.min(s-1,l+c),f=Math.max(0,u-3),b=Math.max(f,u-1),m=0,g=0;for(let E=f;E<=b;E++)m+=a[E],g++;m=g>0?m/g:a[0];let T=Math.min(s-1,h+1),p=Math.min(s-1,h+3),x=0,v=0;for(let E=T;E<=p;E++)x+=a[E],v++;x=v>0?x/v:a[s-1];let S=255,C=!1;for(let E=u;E<=h;E++){let F=a[E];F<S&&(S=F),F<30&&(C=!0)}let L=i>10&&S<Math.min(m,x)-25&&S<100,R;return L&&C?R=`\u26A0 BLACK FRINGE: RGB dips to ${S.toFixed(0)} at edge (inside=${m.toFixed(0)}, outside=${x.toFixed(0)}). Near-black pixels in transition zone \u2192 premult-alpha leak or refraction reads outside FBO.`:L?R=`\u26A0 DARK EDGE: RGB dips to ${S.toFixed(0)} at edge (inside=${m.toFixed(0)}, outside=${x.toFixed(0)}). Edge is darker than both sides.`:C&&i>10?R=`\u26A0 NEAR-BLACK PX at edge: min RGB ${S.toFixed(0)} (inside=${m.toFixed(0)}, outside=${x.toFixed(0)}). Investigate.`:i<=10?R=`~ Flat scan (no sharp edge detected). Max gradient ${i.toFixed(1)}. Element may be off-screen or uniformly colored.`:R=`\u2713 Clean edge. Transition RGB ${S.toFixed(0)} is between inside ${m.toFixed(0)} and outside ${x.toFixed(0)}. No black fringe.`,{edgeIdx:l,edgeOffsetCss:d,transitionHalfW:c,rgbInside:m,rgbOutside:x,minRgbInTransition:S,blackFringeDetected:L,hasNearBlackPx:C,canvasOpaque:n,verdict:R}}var Pr={debugReadEdgeScanline(e=20){this._pendingEdgeScan={halfRangeCss:e},this.requestRender()},debugCycleEdgeScanTarget(){let e=this.buttonConfigs.filter(r=>r.useContinuousSdf&&r.rect.w>0&&r.rect.h>0);return e.length===0?0:(this._edgeScanTargetIdx=(this._edgeScanTargetIdx+1)%e.length,this._pendingEdgeScan={halfRangeCss:20},this.requestRender(),this._edgeScanTargetIdx)},debugClearEdgeScan(){this._pendingEdgeScan=null,this._edgeScanResult=null,this._edgeScanCounter++},_debugFlushPendingEdgeScan(){let e=this._pendingEdgeScan;if(!e)return;this._pendingEdgeScan=null;let r=this.buttonConfigs.filter(B=>B.useContinuousSdf&&B.rect.w>0&&B.rect.h>0).map(B=>{let G=Math.min(B.rect.w,B.rect.h),K=B.cornerRadius>=G/2-.5;return{el:B,isCapsule:K}}).sort((B,G)=>Number(G.isCapsule)-Number(B.isCapsule));if(r.length===0){this._edgeScanCounter++,this._edgeScanResult={scanId:this._edgeScanCounter,elementId:"(none)",targetIdx:0,targetCount:0,isCapsule:!1,rect:{x:0,y:0,w:0,h:0},cornerRadius:0,dpr:this.dpr||1,cornerCenter:{x:0,y:0},cornerPoint45:{x:0,y:0},patchCssX:0,patchCssY:0,patchDevSize:0,halfRange:e.halfRangeCss,patch:new Uint8Array(0),pixels:[],sdfProfile:null,sdfTexSize:0,analysis:{edgeIdx:0,edgeOffsetCss:0,transitionHalfW:0,rgbInside:0,rgbOutside:0,minRgbInTransition:0,blackFringeDetected:!1,hasNearBlackPx:!1,canvasOpaque:!0,verdict:"No useContinuousSdf element found on screen."}};return}let t=this._edgeScanTargetIdx%r.length,s=r[t],a=s.el,{rect:o,cornerRadius:n}=a,i=this.dpr||1,l=this.gl,d=e.halfRangeCss,c=Math.SQRT2,u=o.x+o.w-n,h=o.y+n,f=u+n/c,b=h-n/c,m=f-d,g=b-d,T=d*2,p=Math.max(1,Math.round(T*i)),x=Math.round(m*i),v=Math.round(g*i),S=Math.min(p,this.canvas.width-x),C=Math.min(p,this.canvas.height-v);if(S<=0||C<=0)return;let M=this.canvas.height-(v+C),L=Math.max(0,Math.min(this.canvas.height-C,M));l.bindFramebuffer(l.FRAMEBUFFER,null);let R=new Uint8Array(S*C*4);l.readPixels(x,L,S,C,l.RGBA,l.UNSIGNED_BYTE,R);let E=new Uint8Array(S*C*4);for(let B=0;B<C;B++){let G=C-1-B;E.set(R.subarray(G*S*4,(G+1)*S*4),B*S*4)}let F=Math.min(S,C),y=[];for(let B=0;B<F;B++){let G=S-1-B,j=(B*S+G)*4,re=(F/2-B)/i;y.push({offset:re,r:E[j],g:E[j+1],b:E[j+2],a:E[j+3]})}this._edgeScanCounter++;let U=null,w=0,W=jt(),k=o.w,P=o.h,X=Math.round(n),$=W.find(B=>{let G=B.key.split(",");return Math.round(parseFloat(G[0]))===Math.round(k)&&Math.round(parseFloat(G[1]))===Math.round(P)&&Math.round(parseFloat(G[2]))===X});if($){w=$.texSize;let B=$.tex,G=$.texSize,K=k*i,j=P*i,re=Math.max(K,j),ae=(G-2*4)/re,oe=o.x+o.w/2,te=o.y+o.h/2;U=[];for(let A=0;A<F;A++){let _=S-1-A,V=A,q=m+_/i,O=g+V/i,D=(q-oe)*i,I=(O-te)*i,H=G/2+D*ae,z=G/2+I*ae,N=H/G,bs=z/G,Pt=H,Lt=z,Ce=Math.floor(Pt),Ee=Math.floor(Lt),Pe=Pt-Ce,Le=Lt-Ee,fe=$r=>Math.max(0,Math.min(G-1,$r)),Gt=(fe(Ee)*G+fe(Ce))*4,_t=(fe(Ee)*G+fe(Ce+1))*4,Ot=(fe(Ee+1)*G+fe(Ce))*4,Dt=(fe(Ee+1)*G+fe(Ce+1))*4,It=(1-Pe)*(1-Le),Ht=Pe*(1-Le),zt=(1-Pe)*Le,Ut=Pe*Le,Yr=B[Gt]*It+B[_t]*Ht+B[Ot]*zt+B[Dt]*Ut,Vr=B[Gt+1]*It+B[_t+1]*Ht+B[Ot+1]*zt+B[Dt+1]*Ut,Kr=(F/2-A)/i;U.push({r:Yr,g:Vr,offset:Kr})}}let Y={scanId:this._edgeScanCounter,elementId:a.id,targetIdx:t,targetCount:r.length,isCapsule:s.isCapsule,rect:{x:o.x,y:o.y,w:o.w,h:o.h},cornerRadius:n,dpr:i,cornerCenter:{x:u,y:h},cornerPoint45:{x:f,y:b},patchCssX:m,patchCssY:g,patchDevSize:S,halfRange:d,patch:E,pixels:y,sdfProfile:U,sdfTexSize:w};this._edgeScanResult={...Y,analysis:ds(Y)}}};var Lr={cacheUniforms(){let e=this.gl,r=["uBackdrop","uWallpaperSampler","uTabsBackdropSampler","uCanvasSize","uWallpaperSize","uElementOffset","uElementSize","uBackdropBbox","uCornerRadii","uRefractionHeight","uRefractionAmount","uDepthEffect","uChromaticAberration","uBlurRadius","uSaturation","uBrightness","uContrast","uTintColor","uSurfaceColor","uHighlightColor","uHighlightAngle","uHighlightFalloff","uHighlightAlpha","uHighlightMode","uHighlightStrokeWidth","uHighlightBlur","uContentScaleX","uContentScaleY","uUseToggleBackdrop","uUseSolidBackdrop","uSolidBackdropColor","uTrackColor","uTrackRect","uTrackCornerRadius","uOriginalSize","uOriginalCornerRadius","uLayerScale","uIndicatorBackdrop","uContainerRect","uContainerCornerRadius","uIndicatorAccent","uInsetPx","uIndicatorPressProgress","uIndicatorPanelOffset","uDpr","uContainerCenter","uContainerScale","uTabContentTex0","uTabContentTex1","uTabContentTex2","uTabContentTex3","uTabContentTex4","uTabContentTex5","uTabContentTex6","uTabContentTex7","uTabContentRects[0]","uTabContentRects[1]","uTabContentRects[2]","uTabContentRects[3]","uTabContentRects[4]","uTabContentRects[5]","uTabContentRects[6]","uTabContentRects[7]","uTabContentCount","uTabsGlassLayer","uSdfTexSampler","uUseSdfTexture","uSdfTexSize","uSdfLightAngle","uEnterAlpha","uSdfHighlightScale","uSdfBevelEnabled","uSdfGlassTintHue","uSdfGlassTintEnabled","uSdfGlassTintMix","uSdfGlassTintStrength","uSdfGlassTintSaturation","uSdfGlassTintLightness","uSdfEdgeMatteEnabled","uSdfEdgeMatteTargets","uSdfEdgeMatteBevelParams","uSdfEdgeMatteTintParams","uSdfEdgeMatteBaseParams","uSdfEdgeMatteBrightenParams","uSdfEdgeMatteBevelStrength","uSdfEdgeMatteTintStrength","uSdfEdgeMatteBaseStrength","uSdfEdgeMatteBrightenStrength","uSdfDebugMode","uSdfAaMin","uUsePerElementFbo","uSceneRectOffset","uElFboSize","uBackdropRect","uCornerStyle","uSkipColorControls","uUseMagnifier","uMagnifierZoom","uMagnifierOffsetY","uElementRotation","uContinuousSdf","uUseContinuousSdf","uContinuousSdfTexSize","uContinuousSdfElementSize","uNoContinuousSdfInRefraction","uInnerStrokeMask","uInnerStrokeMaskOffset","uInnerStrokeMaskSize"];ee(e,this.elementProgram,"element",r,this.uEl);let t=["uCanvasSize","uElementOffset","uElementSize","uCornerRadii","uShadowRadius","uShadowOffset","uShadowColor","uOriginalSize","uOriginalCornerRadius","uLayerScale","uElementRotation","uCornerStyle"];ee(e,this.shadowProgram,"shadow",t,this.uSh);let s=["uBackdrop","uCanvasSize","uWallpaperSize"];ee(e,this.wallpaperProgram,"wallpaper",s,this.uWp);let a=["uTexture","uCanvasSize","uOffset","uSize","uCornerRadii","uAlpha","uOriginalSize","uOriginalCornerRadius","uLayerScale","uCornerStyle","uUseContinuousSdf","uContinuousSdf","uContinuousSdfTexSize","uContinuousSdfElementSize"];ee(e,this.foregroundProgram,"foreground",a,this.uFg);let o=["uCanvasSize","uOffset","uSize","uCornerRadii","uColor","uRadius","uPosition","uOriginalSize","uOriginalCornerRadius","uLayerScale","uElementRotation","uCornerStyle"];ee(e,this.highlightProgram,"highlight",o,this.uHl);let n=["uCanvasSize","uOffset","uSize","uCornerRadii","uColor","uOriginalSize","uOriginalCornerRadius","uLayerScale","uElementRotation","uCornerStyle"];ee(e,this.tintProgram,"tint",n,this.uTn);let i=["uCanvasSize","uOffset","uSize","uCornerRadii","uHighlightColor","uHighlightAngle","uHighlightFalloff","uHighlightAlpha","uHighlightMode","uHighlightStrokeWidth","uHighlightBlur","uOriginalSize","uOriginalCornerRadius","uLayerScale","uElementRotation","uCornerStyle","uUseContinuousSdf","uContinuousSdf","uContinuousSdfTexSize","uContinuousSdfElementSize"];ee(e,this.rimHighlightProgram,"rimHighlight",i,this.uRm);let l=["uCanvasSize","uOffset","uSize","uCornerRadii","uHighlightStrokeWidth","uOriginalSize","uOriginalCornerRadius","uLayerScale","uElementRotation","uCornerStyle","uUseContinuousSdf","uContinuousSdf","uContinuousSdfTexSize","uContinuousSdfElementSize"];ee(e,this.highlightStrokeProgram,"highlightStroke",l,this.uHs);let d=["uCanvasSize","uOffset","uSize","uCornerRadii","uBlurredMask","uMaskTexSize","uHighlightColor","uHighlightAngle","uHighlightFalloff","uHighlightAlpha","uHighlightMode","uOriginalSize","uOriginalCornerRadius","uLayerScale","uElementRotation","uCornerStyle","uUseContinuousSdf","uContinuousSdf","uContinuousSdfTexSize","uContinuousSdfElementSize"];ee(e,this.highlightCompositeProgram,"highlightComposite",d,this.uHc);let c=["uCanvasSize","uOffset","uSize","uCornerRadii","uStrokeMask","uMaskOffset","uMaskSize","uHighlightColor","uHighlightAngle","uHighlightFalloff","uHighlightAlpha","uHighlightMode","uOriginalSize","uOriginalCornerRadius","uLayerScale","uElementRotation"];ee(e,this.strokeMaskCompositeProgram,"strokeMaskComposite",c,this.uSm);let u=["uCanvasSize","uOffset","uSize","uCornerRadii","uInnerShadowMask","uMaskOffset","uMaskSize","uInnerShadowColor","uInnerShadowAlpha","uOriginalSize","uOriginalCornerRadius","uLayerScale","uElementRotation"];ee(e,this.innerShadowMaskCompositeProgram,"innerShadowMaskComposite",u,this.uIs);let h=["uCanvasSize","uOffset","uSize","uCornerRadii","uColor","uCornerStyle","uUseContinuousSdf","uContinuousSdf","uContinuousSdfTexSize","uContinuousSdfElementSize"];ee(e,this.plainRectProgram,"plainRect",h,this.uPr);let f=["uBackdrop","uCanvasSize","uWallpaperSize","uOffset","uSize","uBlurRadius","uTintColor","uTintIntensity"];ee(e,this.progressiveBlurProgram,"progressiveBlur",f,this.uPb);let b=["uTexture","uCanvasSize"];ee(e,this.copyProgram,"copy",b,this.uCp);let m=["uColor"];ee(e,this.solidFillProgram,"solidFill",m,this.uSf);let g=["uTexture","uTexSize","uBrightness","uContrast","uSaturation"];ee(e,this.colorControlsProgram,"colorControls",g,this.uCc);let T=["uTexture","uCanvasSize","uTintColor"];ee(e,this.sceneTintProgram,"sceneTint",T,this.uSt);let p=["uTexture","uCanvasSize","uElementCenter","uElementSize","uRotation","uSrcSize"];ee(e,this.elFboCompositeProgram,"elFboComposite",p,this.uEf);let x=["uTexture","uSrcOffset","uSrcSize","uDstSize"];ee(e,this.elFboCropProgram,"elFboCrop",x,this.uEc)}};function Gr(e,r,t,s){let a=d=>{let c=ge(e,e.FRAGMENT_SHADER,t(r,d)),u=ge(e,e.VERTEX_SHADER,Z),h=e.createProgram();if(e.attachShader(h,u),e.attachShader(h,c),e.bindAttribLocation(h,0,"aPos"),e.linkProgram(h),e.deleteShader(u),e.deleteShader(c),!e.getProgramParameter(h,e.LINK_STATUS)){let f=e.getProgramInfoLog(h);throw e.deleteProgram(h),new Error(s+" (taps="+r+","+d+"): "+f)}return h},o=a("horizontal"),n=a("vertical"),i={uTexture:e.getUniformLocation(o,"uTexture"),uTexSize:e.getUniformLocation(o,"uTexSize"),uRadius:e.getUniformLocation(o,"uRadius")},l={uTexture:e.getUniformLocation(n,"uTexture"),uTexSize:e.getUniformLocation(n,"uTexSize"),uRadius:e.getUniformLocation(n,"uRadius")};return{hProg:o,vProg:n,uH:i,uV:l,aPosH:0,aPosV:0}}var _r={ensureBlurPrograms(e){this.blurPrograms.has(e)||this.blurPrograms.set(e,Gr(this.gl,e,ct,"Blur program link error"))},pickDsBlurLevel(e){if(!this.dynamicBlurDownsample||this.dsBlurLevels.length===0)return{ds:this.effectiveBlurDownsample||1,fboA:this.dsBlurFboA,texA:this.dsBlurFboATex,fboB:this.dsBlurFboB,texB:this.dsBlurFboBTex,w:this.dsBlurFboW||this.fboW,h:this.dsBlurFboH||this.fboH};let r=this.dsBlurLevels,t=Math.max(.5,e),s=r[r.length-1].ds,a=1;if(t>=6){let o=Math.floor(Math.log2(t/6));a=Math.pow(2,o)}a>s&&(a=s),a<1&&(a=1);for(let o=r.length-1;o>=0;o--)if(r[o].ds<=a)return r[o];return r[0]},runBlurPasses(e,r,t,s,a,o,n,i,l,d){let c=this.gl,u=performance.now();d?this.ensureBlurPrograms(l):this.ensureHighlightBlurPrograms(l);let h=(d?this.blurPrograms:this.highlightBlurPrograms).get(l),f=performance.now(),b=performance.now(),m=c.getParameter(c.FRAMEBUFFER_BINDING),g=c.isEnabled(c.SCISSOR_TEST),T=c.getParameter(c.SCISSOR_BOX);c.disable(c.SCISSOR_TEST),c.disable(c.BLEND);let p=performance.now(),x=performance.now();c.bindFramebuffer(c.FRAMEBUFFER,r),c.viewport(0,0,o,n),c.useProgram(h.hProg),c.bindBuffer(c.ARRAY_BUFFER,this.quadBuffer),c.enableVertexAttribArray(h.aPosH),c.vertexAttribPointer(h.aPosH,2,c.FLOAT,!1,0,0),c.activeTexture(c.TEXTURE0),c.bindTexture(c.TEXTURE_2D,e),c.uniform1i(h.uH.uTexture,0),c.uniform2f(h.uH.uTexSize,o,n),c.uniform1f(h.uH.uRadius,i),c.drawArrays(c.TRIANGLES,0,6);let v=performance.now(),S=performance.now();c.bindFramebuffer(c.FRAMEBUFFER,s),c.viewport(0,0,o,n),c.useProgram(h.vProg),c.bindBuffer(c.ARRAY_BUFFER,this.quadBuffer),c.enableVertexAttribArray(h.aPosV),c.vertexAttribPointer(h.aPosV,2,c.FLOAT,!1,0,0),c.activeTexture(c.TEXTURE0),c.bindTexture(c.TEXTURE_2D,t),c.uniform1i(h.uV.uTexture,0),c.uniform2f(h.uV.uTexSize,o,n),c.uniform1f(h.uV.uRadius,i),c.drawArrays(c.TRIANGLES,0,6);let C=performance.now(),M=performance.now();c.bindFramebuffer(c.FRAMEBUFFER,m),c.viewport(0,0,this.fboW,this.fboH),g&&(c.enable(c.SCISSOR_TEST),c.scissor(T[0],T[1],T[2],T[3]));let L=performance.now();return this.lastBlurStats&&(this.lastBlurStats.progMs=f-u,this.lastBlurStats.stateMs=p-b+(L-M),this.lastBlurStats.drawMs=v-x+(C-S)),a},blurTexture(e,r,t){if(t)return this.ensureElementFBO(t.w,t.h),this.cropAndBlurBackdrop(e,t.x,t.y,t.w,t.h,r);if(this.useKawaseBlur)return this.kawaseBlurTexture(e,r);let s=this.pickDsBlurLevel(r),a=s.ds,o=a>1?r/a:r;if(o<.5)return this.lastBlurStats={type:"gauss",passes:0,taps:0,maxSample:0,w:s.w,h:s.h,progMs:0,stateMs:0,drawMs:0},e;let n=Re(o);return n=Math.min(n,Math.max(1,this.blurTapCap|0)),this.lastBlurStats={type:"gauss",passes:2,taps:n,maxSample:3*o,w:s.w,h:s.h,progMs:0,stateMs:0,drawMs:0},this.runBlurPasses(e,s.fboA,s.texA,s.fboB,s.texB,s.w,s.h,o,n,!0)},ensureKawaseProgram(){if(this.kawasePrograms)return;let e=this.gl,r=ge(e,e.FRAGMENT_SHADER,ft()),t=ge(e,e.VERTEX_SHADER,Z),s=e.createProgram();if(e.attachShader(s,t),e.attachShader(s,r),e.bindAttribLocation(s,0,"aPos"),e.linkProgram(s),e.deleteShader(t),e.deleteShader(r),!e.getProgramParameter(s,e.LINK_STATUS)){let a=e.getProgramInfoLog(s);throw e.deleteProgram(s),new Error("Kawase program link error: "+a)}this.kawasePrograms={prog:s,uTexture:e.getUniformLocation(s,"uTexture"),uTexSize:e.getUniformLocation(s,"uTexSize"),uRadius:e.getUniformLocation(s,"uRadius"),uIteration:e.getUniformLocation(s,"uIteration"),uTotalIters:e.getUniformLocation(s,"uTotalIters"),aPos:0}},kawaseBlurTexture(e,r){let t=this.pickDsBlurLevel(r),s=t.ds,a=s>1?r/s:r;if(a<.5)return this.lastBlurStats={type:"kawase",passes:0,taps:0,maxSample:0,w:t.w,h:t.h,progMs:0,stateMs:0,drawMs:0},e;let o=ye(a,this.kawaseQuality),n=a*Math.sqrt(6*o/((o+1)*(2*o+1)));this.lastBlurStats={type:"kawase",passes:o,taps:4*o,maxSample:n*Math.SQRT2,w:t.w,h:t.h,progMs:0,stateMs:0,drawMs:0};let i=performance.now();this.ensureKawaseProgram();let l=this.kawasePrograms,d=performance.now(),c=performance.now(),u=this.gl,h=t.w,f=t.h,b=u.getParameter(u.FRAMEBUFFER_BINDING),m=u.isEnabled(u.SCISSOR_TEST),g=u.getParameter(u.SCISSOR_BOX);u.disable(u.SCISSOR_TEST),u.disable(u.BLEND);let T=performance.now(),p=performance.now(),x=e;for(let L=0;L<o;L++){let R=L%2===0,E=R?t.fboA:t.fboB;u.bindFramebuffer(u.FRAMEBUFFER,E),u.viewport(0,0,h,f),u.useProgram(l.prog),u.bindBuffer(u.ARRAY_BUFFER,this.quadBuffer),u.enableVertexAttribArray(l.aPos),u.vertexAttribPointer(l.aPos,2,u.FLOAT,!1,0,0),u.activeTexture(u.TEXTURE0),u.bindTexture(u.TEXTURE_2D,x),u.uniform1i(l.uTexture,0),u.uniform2f(l.uTexSize,h,f),u.uniform1f(l.uRadius,a),u.uniform1f(l.uIteration,L),u.uniform1f(l.uTotalIters,o),u.drawArrays(u.TRIANGLES,0,6),x=R?t.texA:t.texB}let v=performance.now(),S=performance.now();u.bindFramebuffer(u.FRAMEBUFFER,b),u.viewport(0,0,this.fboW,this.fboH),m&&(u.enable(u.SCISSOR_TEST),u.scissor(g[0],g[1],g[2],g[3]));let C=performance.now();return this.lastBlurStats.progMs=d-i,this.lastBlurStats.stateMs=T-c+(C-S),this.lastBlurStats.drawMs=v-p,(o-1)%2===0?t.texA:t.texB},ensureHighlightBlurPrograms(e){this.highlightBlurPrograms.has(e)||this.highlightBlurPrograms.set(e,Gr(this.gl,e,dt,"Highlight blur program link error"))},blurHighlightMask(e,r){let t=this.pickDsBlurLevel(r),s=t.ds,a=s>1?r/s:r;if(a<.01)return e;let o=ht(a);return o=Math.min(o,Math.max(3,this.blurTapCap|0)),this.runBlurPasses(e,t.fboA,t.texA,t.fboB,t.texB,t.w,t.h,a,o,!1)}};var Or={releaseGpuResources(){let e=this.gl;this.wallpaperTexture&&e.deleteTexture(this.wallpaperTexture),this.wallpaperTexture=null,this.wallpaperReady=!1;for(let r of this.fgTextures.values())e.deleteTexture(r);this.fgTextures.clear();for(let r of this.strokeMaskCache.values())e.deleteTexture(r.tex);this.strokeMaskCache.clear(),Ar(e,this.innerShadowMaskCache),this.fboA&&e.deleteFramebuffer(this.fboA),this.fboATex&&e.deleteTexture(this.fboATex),this.fboB&&e.deleteFramebuffer(this.fboB),this.fboBTex&&e.deleteTexture(this.fboBTex),this.fboA=this.fboB=null,this.fboATex=this.fboBTex=null,this.tabsBackdropFbo&&e.deleteFramebuffer(this.tabsBackdropFbo),this.tabsBackdropTex&&e.deleteTexture(this.tabsBackdropTex),this.tabsBackdropFbo=null,this.tabsBackdropTex=null,this.wallpaperBlurFbo&&e.deleteFramebuffer(this.wallpaperBlurFbo),this.wallpaperBlurTex&&e.deleteTexture(this.wallpaperBlurTex),this.blurFboA&&e.deleteFramebuffer(this.blurFboA),this.blurFboATex&&e.deleteTexture(this.blurFboATex),this.blurFboB&&e.deleteFramebuffer(this.blurFboB),this.blurFboBTex&&e.deleteTexture(this.blurFboBTex),this.dsBlurFboA&&e.deleteFramebuffer(this.dsBlurFboA),this.dsBlurFboATex&&e.deleteTexture(this.dsBlurFboATex),this.dsBlurFboB&&e.deleteFramebuffer(this.dsBlurFboB),this.dsBlurFboBTex&&e.deleteTexture(this.dsBlurFboBTex);for(let r of this.dsBlurLevels)e.deleteFramebuffer(r.fboA),e.deleteTexture(r.texA),e.deleteFramebuffer(r.fboB),e.deleteTexture(r.texB);this.dsBlurLevels=[],this.wallpaperBlurFbo=this.blurFboA=this.blurFboB=this.dsBlurFboA=this.dsBlurFboB=null,this.wallpaperBlurTex=this.blurFboATex=this.blurFboBTex=this.dsBlurFboATex=this.dsBlurFboBTex=null,this.highlightMaskFbo&&e.deleteFramebuffer(this.highlightMaskFbo),this.highlightMaskTex&&e.deleteTexture(this.highlightMaskTex),this.highlightMaskFbo=null,this.highlightMaskTex=null,this.dialogBackdropFbo&&e.deleteFramebuffer(this.dialogBackdropFbo),this.dialogBackdropTex&&e.deleteTexture(this.dialogBackdropTex),this.dialogBackdropFbo=null,this.dialogBackdropTex=null,this.dialogBackdropKey=null,this.bgOnlyFbo&&e.deleteFramebuffer(this.bgOnlyFbo),this.bgOnlyTex&&e.deleteTexture(this.bgOnlyTex),this.bgOnlyFbo=null,this.bgOnlyTex=null,this.elFbo&&e.deleteFramebuffer(this.elFbo),this.elFboTex&&e.deleteTexture(this.elFboTex),this.elFbo=null,this.elFboTex=null,this.elFboW=this.elFboH=0,this.backdropCropFbo&&e.deleteFramebuffer(this.backdropCropFbo),this.backdropCropTex&&e.deleteTexture(this.backdropCropTex),this.backdropCropFbo=null,this.backdropCropTex=null,this.elBlurFboA&&e.deleteFramebuffer(this.elBlurFboA),this.elBlurFboATex&&e.deleteTexture(this.elBlurFboATex),this.elBlurFboB&&e.deleteFramebuffer(this.elBlurFboB),this.elBlurFboBTex&&e.deleteTexture(this.elBlurFboBTex),this.elBlurFboA=this.elBlurFboB=null,this.elBlurFboATex=this.elBlurFboBTex=null;for(let r of this.elFboCache.values())e.deleteFramebuffer(r.fb),e.deleteTexture(r.tex);this.elFboCache.clear();for(let{hProg:r,vProg:t}of this.blurPrograms.values())e.deleteProgram(r),e.deleteProgram(t);this.blurPrograms.clear();for(let{hProg:r,vProg:t}of this.highlightBlurPrograms.values())e.deleteProgram(r),e.deleteProgram(t);this.highlightBlurPrograms.clear(),this.kawasePrograms&&(e.deleteProgram(this.kawasePrograms.prog),this.kawasePrograms=null);for(let r of this.backdropBlurCache.values())e.deleteTexture(r.tex),e.deleteFramebuffer(r.fb);this.backdropBlurCache.clear();for(let r of this.backdropBlurCacheFboPool)e.deleteTexture(r.tex),e.deleteFramebuffer(r.fb);this.backdropBlurCacheFboPool.length=0,this.cacheCopyReadFbo&&(e.deleteFramebuffer(this.cacheCopyReadFbo),this.cacheCopyReadFbo=null),this.sdfTexture&&e.deleteTexture(this.sdfTexture),this.sdfTexture=null,this.textSdfTexture&&e.deleteTexture(this.textSdfTexture),this.textSdfTexture=null;for(let{tex:r}of this.continuousSdfPool.values())e.deleteTexture(r);this.continuousSdfPool.clear(),this.continuousSdfTexture=null,this.continuousSdfKey=null,this._debugUploadedSdfTexMap.clear(),e.deleteProgram(this.elementProgram),e.deleteProgram(this.shadowProgram),e.deleteProgram(this.wallpaperProgram),e.deleteProgram(this.foregroundProgram),e.deleteProgram(this.highlightProgram),e.deleteProgram(this.tintProgram),e.deleteProgram(this.rimHighlightProgram),e.deleteProgram(this.highlightStrokeProgram),e.deleteProgram(this.highlightCompositeProgram),e.deleteProgram(this.strokeMaskCompositeProgram),e.deleteProgram(this.innerShadowMaskCompositeProgram),e.deleteProgram(this.plainRectProgram),e.deleteProgram(this.progressiveBlurProgram),e.deleteProgram(this.copyProgram),e.deleteProgram(this.solidFillProgram),e.deleteProgram(this.colorControlsProgram),e.deleteProgram(this.sceneTintProgram),e.deleteProgram(this.elFboCompositeProgram),e.deleteProgram(this.elFboCropProgram),e.deleteBuffer(this.quadBuffer)},dispose(){this.rafId!==null&&cancelAnimationFrame(this.rafId),this.rafId=null,this.animRafId!==null&&cancelAnimationFrame(this.animRafId),this.animRafId=null,this.canvas.removeEventListener("webglcontextlost",this.onContextLost,!1),this.canvas.removeEventListener("webglcontextrestored",this.onContextRestored,!1),this.reduceMotionMql?.removeEventListener("change",this.onReduceMotionChange),this.reduceMotionMql=null,this.releaseGpuResources(),this.wallpaperSrc=null,this.sdfSrc=null,this.textSdfPixels=null}};var ce=class{constructor(r,t){this.wallpaperTexture=null;this.wallpaperReady=!1;this.wallpaperSize=[1,1];this.dpr=0;this.buttonConfigs=[];this.buttonStates=new Map;this.toggleStates=new Map;this.scrollY=0;this.scrollVelocity=0;this.contentHeight=0;this.cssWidth=0;this.cssHeight=0;this.wheelTarget=null;this.backgroundColor=null;this.overlayMode=!1;this.needsRedraw=!0;this.dirtyElementIds=new Set;this.allDirty=!0;this.showDirtyMarkers=!1;this.debugDirtyMarkers=[];this._dbgLastGlassCacheHit=!1;this.dirtyRectsThisFrame=[];this.lastRenderedScrollY=0;this.debugCacheMissLog=[];this.debugDirtySourceLog=[];this.fboA=null;this.fboATex=null;this.fboB=null;this.fboBTex=null;this.fboW=0;this.fboH=0;this.tabsBackdropFbo=null;this.tabsBackdropTex=null;this.tabsBackdropDirty=!0;this.wallpaperBlurFbo=null;this.wallpaperBlurTex=null;this.blurFboA=null;this.blurFboATex=null;this.blurFboB=null;this.blurFboBTex=null;this.dsBlurFboA=null;this.dsBlurFboATex=null;this.dsBlurFboB=null;this.dsBlurFboBTex=null;this.highlightMaskFbo=null;this.highlightMaskTex=null;this.dialogBackdropFbo=null;this.dialogBackdropTex=null;this.dialogBackdropKey=null;this.bgOnlyFbo=null;this.bgOnlyTex=null;this.blurPrograms=new Map;this.highlightBlurPrograms=new Map;this.kawasePrograms=null;this.useKawaseBlur=!0;this.useBlurCache=!0;this.kawaseQuality=1;this.gravityAngle=45*Math.PI/180;this.blurTapCap=9;this.blurDownsample=4;this.dsBlurFboW=0;this.dsBlurFboH=0;this.effectiveBlurDownsample=4;this.dynamicBlurDownsample=!1;this.dsBlurLevels=[];this.cornerStyle=1;this.capsuleSdfQuality=.5;this.noContinuousSdf=!0;this.directBackdropSample=!0;this.usePerElementFbo=!1;this.quickToggles={highlight:!0,backdropBlur:!0,chromatic:!0,refraction:!0,outerShadow:!0,innershadow:!0,perElementFbo:!1,isolateBackdrop:!1};this.isSoftwareRenderer=!1;this.showPefBbox=!1;this.debugPefBboxes=[];this.showBlurDebug=!1;this.debugBlurRegions=[];this.lastBlurStats=null;this.backdropBlurCache=new Map;this.backdropBlurCacheFboPool=[];this.cacheCopyReadFbo=null;this.backdropBlurCacheMax=64;this._blurCacheMissesThisFrame=0;this.blurCacheMissesPerFrame=1;this._lastBlurCacheScrollY=0;this.showBlurCacheCheckerboard=!1;this.showBlurCachePreview=!1;this.backdropBlurCacheSnapshots=[];this.showShadowBbox=!1;this.debugShadowBboxes=[];this.debugSdfHoleTopLeftR=!1;this.debugSdfHoleTopLeftG=!1;this.showCullDebug=!1;this.debugCullRects=[];this.showPefPassDebug=!1;this.debugPefPasses=[];this.showPlainRectDebug=!1;this.debugPlainRects=[];this.perfMonitor=new _e;this.elFbo=null;this.elFboTex=null;this.elFboW=0;this.elFboH=0;this.elFboCache=new Map;this.wallpaperVersion=0;this.backdropCropFbo=null;this.backdropCropTex=null;this.elBlurFboA=null;this.elBlurFboATex=null;this.elBlurFboB=null;this.elBlurFboBTex=null;this.sdfTexture=null;this.sdfTextureReady=!1;this.sdfTextureSize=[1,1];this.textSdfTexture=null;this.textSdfTextureReady=!1;this.textSdfTextureSize=[1,1];this.continuousSdfPool=new Map;this.continuousSdfTexture=null;this.continuousSdfTexSize=[128,128];this.continuousSdfKey=null;this.dummyTex=null;this._lastCapsuleGenMs=0;this._lastCapsuleUploadMs=0;this._lastCapsuleKey="";this._debugUploadedSdfTexMap=new Map;this._pendingEdgeScan=null;this._edgeScanResult=null;this._edgeScanCounter=0;this._edgeScanTargetIdx=0;this.fgTextures=new Map;this.fgDirtyIds=new Set;this.strokeMaskCache=new Map;this.innerShadowMaskCache=new Map;this.rafId=null;this.animRafId=null;this.reduceMotion=!1;this.reduceMotionMql=null;this.onReduceMotionChange=r=>{this.reduceMotion=r.matches,this.startAnimation()};this.contextLost=!1;this.wallpaperSrc=null;this.sdfSrc=null;this.textSdfPixels=null;this.pendingExtraRenders=0;this.uEl={};this.uSh={};this.uWp={};this.uFg={};this.uHl={};this.uTn={};this.uRm={};this.uHs={};this.uHc={};this.uSm={};this.uIs={};this.uPr={};this.uPb={};this.uCp={};this.uSf={};this.uCc={};this.uSt={};this.uEf={};this.uEc={};this.onContextLost=r=>{r.preventDefault(),this.contextLost=!0,this.rafId!==null&&(cancelAnimationFrame(this.rafId),this.rafId=null),this.animRafId!==null&&(cancelAnimationFrame(this.animRafId),this.animRafId=null),this.releaseGpuResources()};this.onContextRestored=()=>{this.contextLost=!1,this.initGlResources(),this.initContextMeta(),this.resizeFBOs(this.canvas.width,this.canvas.height,!0),this.wallpaperSrc&&this.loadWallpaper(this.wallpaperSrc),this.sdfSrc&&this.loadSdfTexture(this.sdfSrc),this.textSdfPixels&&this.loadTextSdfTextureFromData(this.textSdfPixels.data,this.textSdfPixels.w,this.textSdfPixels.h),this.markAllDirty(),this.requestRender()};this.canvas=r,this.overlayMode=t?.overlay===!0;let s=r.getContext("webgl",{premultipliedAlpha:this.overlayMode,alpha:this.overlayMode,antialias:!1,preserveDrawingBuffer:!1,powerPreference:"low-power"});if(!s)throw new Error("WebGL not supported");this.gl=s,this.initGlResources(),this.initContextMeta(),r.addEventListener("webglcontextlost",this.onContextLost,!1),r.addEventListener("webglcontextrestored",this.onContextRestored,!1);let a=typeof window<"u"&&typeof window.matchMedia=="function"?window.matchMedia("(prefers-reduced-motion: reduce)"):null;a&&(this.reduceMotionMql=a,this.reduceMotion=a.matches,a.addEventListener("change",this.onReduceMotionChange))}get _debugLastUploadedSdfTex(){let r=Array.from(this._debugUploadedSdfTexMap.values());return r.length?r[r.length-1].tex:null}get _debugLastUploadedSdfKey(){let r=Array.from(this._debugUploadedSdfTexMap.keys());return r.length?r[r.length-1]:""}get _debugLastUploadedSdfTexSize(){let r=Array.from(this._debugUploadedSdfTexMap.values());return r.length?r[r.length-1].texSize:0}clearCapsuleSdfPool(){let r=this.gl;for(let{tex:t}of this.continuousSdfPool.values())r.deleteTexture(t);this.continuousSdfPool.clear(),this.continuousSdfTexture=null,this.continuousSdfKey=null,this._lastCapsuleGenMs=0,this._lastCapsuleUploadMs=0,this._lastCapsuleKey="",this._debugUploadedSdfTexMap.clear()}clearStrokeMaskCache(){let r=this.gl,t=this.strokeMaskCache.size;for(let s of this.strokeMaskCache.values())r.deleteTexture(s.tex);return this.strokeMaskCache.clear(),t}initGlResources(){let r=this.gl;this.elementProgram=J(r,Z,qe),this.shadowProgram=J(r,Z,Ye),this.wallpaperProgram=J(r,Z,et),this.foregroundProgram=J(r,Z,nt),this.highlightProgram=J(r,Z,Ve),this.tintProgram=J(r,Z,Ke),this.rimHighlightProgram=J(r,Z,$e),this.highlightStrokeProgram=J(r,Z,je),this.highlightCompositeProgram=J(r,Z,Ze),this.strokeMaskCompositeProgram=J(r,Z,Qe),this.innerShadowMaskCompositeProgram=J(r,Z,Je),this.plainRectProgram=J(r,Z,lt),this.progressiveBlurProgram=J(r,Z,ut),this.copyProgram=J(r,Z,tt),this.solidFillProgram=J(r,Z,rt),this.colorControlsProgram=J(r,Z,ot),this.sceneTintProgram=J(r,Z,it),this.elFboCompositeProgram=J(r,Z,at),this.elFboCropProgram=J(r,Z,st),this.quadBuffer=r.createBuffer(),r.bindBuffer(r.ARRAY_BUFFER,this.quadBuffer),r.bufferData(r.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),r.STATIC_DRAW),this.aPosLocEl=r.getAttribLocation(this.elementProgram,"aPos"),this.aPosLocSh=r.getAttribLocation(this.shadowProgram,"aPos"),this.aPosLocWp=r.getAttribLocation(this.wallpaperProgram,"aPos"),this.aPosLocFg=r.getAttribLocation(this.foregroundProgram,"aPos"),this.aPosLocHl=r.getAttribLocation(this.highlightProgram,"aPos"),this.aPosLocTn=r.getAttribLocation(this.tintProgram,"aPos"),this.aPosLocRm=r.getAttribLocation(this.rimHighlightProgram,"aPos"),this.aPosLocHs=r.getAttribLocation(this.highlightStrokeProgram,"aPos"),this.aPosLocHc=r.getAttribLocation(this.highlightCompositeProgram,"aPos"),this.aPosLocSm=r.getAttribLocation(this.strokeMaskCompositeProgram,"aPos"),this.aPosLocIs=r.getAttribLocation(this.innerShadowMaskCompositeProgram,"aPos"),this.aPosLocPr=r.getAttribLocation(this.plainRectProgram,"aPos"),this.aPosLocPb=r.getAttribLocation(this.progressiveBlurProgram,"aPos"),this.aPosLocCp=r.getAttribLocation(this.copyProgram,"aPos"),this.aPosLocSf=r.getAttribLocation(this.solidFillProgram,"aPos"),this.aPosLocCc=r.getAttribLocation(this.colorControlsProgram,"aPos"),this.aPosLocSt=r.getAttribLocation(this.sceneTintProgram,"aPos"),this.aPosLocEf=r.getAttribLocation(this.elFboCompositeProgram,"aPos"),this.aPosLocEc=r.getAttribLocation(this.elFboCropProgram,"aPos"),this.fgCanvas=typeof document<"u"?document.createElement("canvas"):null;let t=this.fgCanvas?.getContext("2d",{alpha:!0});if(!t)throw new Error("2D canvas not supported");this.fgCtx=t,this.dummyTex=r.createTexture(),r.bindTexture(r.TEXTURE_2D,this.dummyTex),r.texImage2D(r.TEXTURE_2D,0,r.RGBA,1,1,0,r.RGBA,r.UNSIGNED_BYTE,new Uint8Array([0,0,0,0])),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_MIN_FILTER,r.LINEAR),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_MAG_FILTER,r.LINEAR),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_WRAP_S,r.CLAMP_TO_EDGE),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_WRAP_T,r.CLAMP_TO_EDGE),this.cacheUniforms()}initContextMeta(){let r=this.gl;this.perfMonitor.attachGl(r),this.detectSoftwareRenderer(),this.perfMonitor.isSoftwareRenderer=this.isSoftwareRenderer}detectSoftwareRenderer(){let r=this.gl;try{let t=r.getExtension("WEBGL_debug_renderer_info"),a=String(t?r.getParameter(t.UNMASKED_RENDERER_WEBGL)||"":r.getParameter(r.RENDERER)||"").toLowerCase();this.isSoftwareRenderer=a.includes("swiftshader")||a.includes("llvmpipe")||a.includes("softpipe")||a.includes("swrast")||a.includes("software")||a.includes("basic render")||a.includes("mesa software")||a.includes("apple software")}catch{}}anyDebugOverlayOn(){return this.showPefBbox||this.showBlurDebug||this.showShadowBbox||this.showCullDebug||this.showPlainRectDebug||this.showPefPassDebug||this.showDirtyMarkers}};ce.TAB_PRESSED_SCALE=78/56;Object.assign(ce.prototype,qt,Qt,Jt,er,tr,sr,ar,or,dr,hr,fr,mr,gr,pr,cr,Tr,kr,Br,Pr,Lr,_r,Or);function hs(e,r,t,s,a,o,n){e.save(),e.translate(r,t),e.scale(s,a);let i=e.createRadialGradient(0,0,0,0,0,1);for(let[l,d]of o)i.addColorStop(l,d);e.fillStyle=i,e.fillRect((n[0]-r)/s,(n[1]-t)/a,(n[2]-n[0])/s,(n[3]-n[1])/a),e.restore()}function Mt(e,r,t,s,a,o,n,i,l){let d=r+o*s,c=t+n*a,u=Math.max(o,1-o)*s,h=Math.max(n,1-n)*a,f=i*Math.hypot(u,h);if(f<.5)return;let b=e.createRadialGradient(d,c,0,d,c,f);for(let[m,g]of l)b.addColorStop(m,g);e.fillStyle=b,e.fillRect(d-f,c-f,f*2,f*2)}function Dr(e,r){try{e.filter=r>0?`blur(${r}px)`:"none"}catch{}}function kt(e,r,t,s,a,o,n){e.save(),e.globalAlpha=n,Dr(e,o),e.fillStyle=a,e.beginPath(),e.arc(r,t,s,0,Math.PI*2),e.fill(),e.restore()}function fs(e,r){let t=document.createElement("canvas");t.width=Math.max(1,Math.round(e)),t.height=Math.max(1,Math.round(r));let s=t.getContext("2d");s.fillStyle="rgba(255,255,255,0.055)";for(let l=0;l<=e;l+=44)s.fillRect(l,0,1,r);for(let l=0;l<=r;l+=44)s.fillRect(0,l,e,1);s.globalCompositeOperation="destination-in";let a=.5*e,o=.45*r,n=Math.hypot(.5*e,.55*r),i=s.createRadialGradient(a,o,0,a,o,n);return i.addColorStop(0,"rgba(0,0,0,1)"),i.addColorStop(.55,"rgba(0,0,0,0.35)"),i.addColorStop(.78,"rgba(0,0,0,0)"),s.fillStyle=i,s.fillRect(0,0,e,r),t}async function Ir(e,r,t){let s=Math.max(1,Math.round(e*t)),a=Math.max(1,Math.round(r*t)),o=document.createElement("canvas");o.width=s,o.height=a;let n=o.getContext("2d");n.scale(t,t);let i=[0,0,e,r];hs(n,.12*e,.08*r,1.2*e,1.2*r,[[0,"#7ea6e8"],[.26,"#4c7fd6"],[.52,"#2b5fc4"],[.8,"#16356a"],[1,"#0a1f42"]],i),kt(n,.1*e+190,.12*r+190,190,"#4a92ff",46,.6),kt(n,.88*e-150,.9*r-150,150,"#9a6cff",46,.6),kt(n,.58*e+115,.62*r+115,115,"#34d0ff",46,.6);let l=.85*Math.max(e,r),d=(e-l)/2,c=(r-l)/2;return n.save(),Dr(n,6),Mt(n,d,c,l,l,.25,.25,.45,[[0,"rgba(255,255,255,0.38)"],[1,"rgba(255,255,255,0)"]]),Mt(n,d,c,l,l,.75,.65,.4,[[0,"rgba(94,181,255,0.55)"],[1,"rgba(94,181,255,0)"]]),Mt(n,d,c,l,l,.7,.15,.38,[[0,"rgba(166,130,255,0.5)"],[1,"rgba(166,130,255,0)"]]),n.restore(),n.drawImage(fs(e,r),0,0,e,r),{url:await new Promise((h,f)=>{o.toBlob(b=>{b?h(URL.createObjectURL(b)):f(new Error("toBlob failed"))},"image/png")}),w:o.width,h:o.height}}var Ti=48*1,vi=16*1,ms=15*1,Ci=15*1,Ei=28*1;var ke={refractionHeight:12*1,refractionAmount:-24*1,depthEffect:!1,chromaticAberration:!1,blurRadius:2*1,saturation:1.5,brightness:0,contrast:1},Be={mode:0,color:[1,1,1],angle:45*Math.PI/180,falloff:1,alpha:.5,widthDp:.5},Bt={radius:24*1,alpha:.1,offsetX:0,offsetY:24/6*1,color:[0,0,0]};var Ri=6*1,yi=40*1,Ai=24*1,wi=48*1,Fi=16*1,Mi=32*1,ki=24*1;var Bi=56*1;var be={homeContentColor:[0,0,0,1],homeSubtitleColor:[0/255,136/255,255/255,1],homeTextHalo:"dark",toggleAccent:[52/255,199/255,89/255],toggleTrackOff:[120/255,120/255,120/255,.2],toggleCardBg:[1,1,1,1],sliderAccent:[0/255,136/255,255/255],sliderTrackOff:[120/255,120/255,120/255,.2],sliderCardBg:[1,1,1,1],tabsContentColor:[0,0,0,1],tabsAccent:[0/255,136/255,255/255],tabsContainer:[250/255,250/255,250/255,.4],tabsTextHalo:"dark",dialogContentColor:[0,0,0,1],dialogAccent:[0/255,136/255,255/255,1],dialogContainer:[250/255,250/255,250/255,.6],dialogDim:[41/255,41/255,58/255,.23],dialogBlurRadius:16*1,dialogBrightness:.2,magnifierContentColor:[0,0,0,1],magnifierAccent:[0/255,136/255,255/255,1],magnifierCardBg:[1,1,1,.9],controlCenterAccent:[0/255,136/255,255/255,1],progressiveContentColor:[0,0,0,1],progressiveTint:[1,1,1,1],progressiveTextHalo:"dark",adaptiveContentColor:[0,0,0,1],backIconColor:[0,0,0,1],buttonSurface:[1,1,1,.3]},Gi={homeContentColor:[1,1,1,1],homeSubtitleColor:[0/255,136/255,255/255,1],homeTextHalo:"light",toggleAccent:[48/255,209/255,88/255],toggleTrackOff:[120/255,120/255,128/255,.36],toggleCardBg:[18/255,18/255,18/255,1],sliderAccent:[0/255,145/255,255/255],sliderTrackOff:[120/255,120/255,128/255,.36],sliderCardBg:[18/255,18/255,18/255,1],tabsContentColor:[1,1,1,1],tabsAccent:[0/255,145/255,255/255],tabsContainer:[18/255,18/255,18/255,.4],tabsTextHalo:"light",dialogContentColor:[1,1,1,1],dialogAccent:[0/255,145/255,255/255,1],dialogContainer:[18/255,18/255,18/255,.4],dialogDim:[18/255,18/255,18/255,.56],dialogBlurRadius:8*1,dialogBrightness:0,magnifierContentColor:[1,1,1,1],magnifierAccent:[0/255,145/255,255/255,1],magnifierCardBg:[18/255,18/255,18/255,.9],controlCenterAccent:[0/255,145/255,255/255,1],progressiveContentColor:[1,1,1,1],progressiveTint:[128/255,128/255,128/255,1],progressiveTextHalo:"light",adaptiveContentColor:[1,1,1,1],backIconColor:[1,1,1,1],buttonSurface:[18/255,18/255,18/255,.4]};var _i=be.toggleAccent,Oi=be.toggleTrackOff,Di=be.sliderAccent,Ii=be.sliderTrackOff,Hi=be.dialogContainer,zi=be.dialogAccent,Ui=be.dialogDim;function Hr(e,r,t,s=!0){return{id:e,kind:"button",rect:r,...ke,cornerRadius:r.h/2,saturation:t.saturation??ke.saturation,brightness:t.brightness??ke.brightness,contrast:t.contrast??ke.contrast,tintColor:t.tintColor,surfaceColor:t.surfaceColor,highlight:{...Be},outerShadow:{...Bt},label:t.label,labelColor:t.labelColor,labelFontSizePx:t.labelFontSizePx,showChevron:!1,isInteractive:!0,scroll:s,independentBackdrop:!1,directBackdropSample:!0}}function zr(e,r,t={},s=!0){return{id:e,kind:"glass-shape",rect:r,cornerRadius:t.cornerRadius??r.h/2,refractionHeight:t.refractionHeight??12*1,refractionAmount:t.refractionAmount??-24*1,depthEffect:t.depthEffect??!1,chromaticAberration:t.chromaticAberration??!1,blurRadius:t.blurRadius??2*1,saturation:t.saturation??1.5,brightness:t.brightness??0,contrast:t.contrast??1,tintColor:t.tintColor??[0,0,0,0],surfaceColor:t.surfaceColor??[0,0,0,0],highlight:t.highlight!==void 0?t.highlight:{...Be},outerShadow:t.outerShadow!==void 0?t.outerShadow:{...Bt},label:"",labelColor:[0,0,0,1],showChevron:!1,isInteractive:!1,scroll:s,innerShadow:t.innerShadow??null,independentBackdrop:!0}}function Ur(e,r,t,s){let a=zr(e,r,{cornerRadius:t.cornerRadius,surfaceColor:t.surfaceColor??[1,1,1,.08],tintColor:t.tintColor??[0,0,0,0],blurRadius:t.blurRadius??8,saturation:t.saturation??1.5,brightness:t.brightness??0,contrast:t.contrast??1,refractionHeight:t.refractionHeight,refractionAmount:t.refractionAmount,highlight:{...Be},outerShadow:null},!1);return a.elementAlpha=s,a}function Wr(e,r,t,s){let a=Hr(e,r,{label:"",tintColor:t.tintColor??[0,0,0,0],surfaceColor:t.surfaceColor??[1,1,1,.12],labelColor:[0,0,0,0],saturation:t.saturation??1.5,brightness:t.brightness??0,contrast:t.contrast??1},!1);return a.cornerRadius=t.cornerRadius,a.blurRadius=t.blurRadius??2,t.refractionHeight!==void 0&&(a.refractionHeight=t.refractionHeight),t.refractionAmount!==void 0&&(a.refractionAmount=t.refractionAmount),a.outerShadow=null,a.elementAlpha=s,a}var Nr=600;function gs(e){let r=1;for(let t=e;t&&t!==document.documentElement;t=t.parentElement){let s=parseFloat(getComputedStyle(t).opacity);if(Number.isNaN(s)||(r*=s),r<=.002)return 0}return r}var Xe=class{constructor(r,t){this.ids=new WeakMap;this.pressBound=new WeakSet;this.nextId=0;this.lastSig="";this.syncRaf=null;this.burstUntil=0;this.burstRaf=null;this.resizeRaf=null;this.resizeTimer=null;this.wallpaperUrl=null;this.disposed=!1;this.observers=[];this.opts={wallpaperScale:2,activeClass:"lg",...t},this.canvas=r,this.renderer=new ce(r,{overlay:!0}),this.renderer.setBackgroundColor(null),this.attachListeners()}async start(){await this.repaintWallpaper(),!this.disposed&&(this.resize(),this.sync(),document.documentElement.classList.add(this.opts.activeClass))}dispose(){this.disposed=!0;for(let r of this.observers)r();this.observers.length=0,this.syncRaf!==null&&cancelAnimationFrame(this.syncRaf),this.burstRaf!==null&&cancelAnimationFrame(this.burstRaf),this.resizeRaf!==null&&cancelAnimationFrame(this.resizeRaf),this.resizeTimer!==null&&window.clearTimeout(this.resizeTimer),this.wallpaperUrl&&URL.revokeObjectURL(this.wallpaperUrl),this.renderer.dispose(),this.canvas.remove(),document.documentElement.classList.remove(this.opts.activeClass)}viewport(){return{w:document.documentElement.clientWidth||window.innerWidth,h:document.documentElement.clientHeight||window.innerHeight}}resize(){let{w:r,h:t}=this.viewport();r<1||t<1||this.renderer.resize(r,t)}async repaintWallpaper(){let{w:r,h:t}=this.viewport();if(r<1||t<1)return;let s=Math.min(window.devicePixelRatio||1,this.opts.wallpaperScale),a=await Ir(r,t,s);if(this.disposed){URL.revokeObjectURL(a.url);return}let o=this.wallpaperUrl;this.wallpaperUrl=a.url;try{await this.renderer.loadWallpaper(a.url)}finally{o&&URL.revokeObjectURL(o)}}sync(){if(this.disposed)return;let r=this.canvas.getBoundingClientRect(),t=[],s=[];for(let o of this.opts.targets)for(let n of Array.from(document.querySelectorAll(o.selector))){let i=n,l=i.getBoundingClientRect();if(l.width<1||l.height<1)continue;let d=gs(i);if(d<=.01)continue;let c={x:l.left-r.left,y:l.top-r.top,w:l.width,h:l.height},u=this.idFor(i),h={...o,cornerRadius:o.cornerRadiusFrac!==void 0?c.h*o.cornerRadiusFrac:o.cornerRadius};t.push(o.role==="button"?Wr(u,c,h,d):Ur(u,c,h,d)),s.push(`${u}:${c.x.toFixed(1)},${c.y.toFixed(1)},${c.w.toFixed(1)},${c.h.toFixed(1)},${d.toFixed(3)}`),o.role==="button"&&this.bindPress(i,u)}let a=s.join("|");a!==this.lastSig&&(this.lastSig=a,this.renderer.setElements(t))}idFor(r){let t=this.ids.get(r);return t||(t=`lg-${this.nextId++}`,this.ids.set(r,t)),t}bindPress(r,t){if(this.pressBound.has(r))return;this.pressBound.add(r);let s=a=>{let o=this.canvas.getBoundingClientRect();return{x:a.clientX-o.left,y:a.clientY-o.top}};r.addEventListener("pointerdown",a=>{if(a.button!==0)return;this.renderer.setPressed(t,!0,s(a));let o=i=>this.renderer.setDragPosition(t,s(i)),n=()=>{this.renderer.setPressed(t,!1),window.removeEventListener("pointermove",o),window.removeEventListener("pointerup",n),window.removeEventListener("pointercancel",n)};window.addEventListener("pointermove",o),window.addEventListener("pointerup",n),window.addEventListener("pointercancel",n)}),r.addEventListener("pointerleave",()=>this.renderer.setPressed(t,!1))}schedule(){this.disposed||this.syncRaf!==null||(this.syncRaf=requestAnimationFrame(()=>{this.syncRaf=null,this.sync()}))}scheduleResize(){this.disposed||this.resizeRaf!==null||(this.resizeRaf=requestAnimationFrame(()=>{this.resizeRaf=null,this.resize()}))}burst(r=Nr){if(this.disposed)return;let t=performance.now()+r;if(t>this.burstUntil&&(this.burstUntil=t),this.burstRaf!==null)return;let s=()=>{this.burstRaf=null,this.sync(),!this.disposed&&performance.now()<this.burstUntil&&(this.burstRaf=requestAnimationFrame(s))};this.burstRaf=requestAnimationFrame(s)}attachListeners(){let r=()=>this.schedule();document.addEventListener("scroll",r,{capture:!0,passive:!0}),this.observers.push(()=>document.removeEventListener("scroll",r,!0));let t=()=>this.burst();document.addEventListener("transitionrun",t,!0),this.observers.push(()=>document.removeEventListener("transitionrun",t,!0));let s=()=>{this.scheduleResize(),this.schedule()};window.addEventListener("resize",s),this.observers.push(()=>window.removeEventListener("resize",s));let a=()=>{this.scheduleResize(),this.schedule()};window.addEventListener("orientationchange",a),this.observers.push(()=>window.removeEventListener("orientationchange",a));let o=new MutationObserver(()=>this.burst(Nr));if(o.observe(document.body,{subtree:!0,attributes:!0,attributeFilter:["class","style","hidden","disabled"]}),this.observers.push(()=>o.disconnect()),typeof ResizeObserver<"u"){let i=new ResizeObserver(()=>this.schedule());i.observe(document.documentElement);for(let l of this.opts.targets)for(let d of Array.from(document.querySelectorAll(l.selector)))i.observe(d);this.observers.push(()=>i.disconnect())}let n=()=>{this.resizeTimer!==null&&window.clearTimeout(this.resizeTimer),this.resizeTimer=window.setTimeout(()=>{this.resizeTimer=null,this.resize(),this.repaintWallpaper().then(()=>this.sync())},180)};window.addEventListener("resize",n),this.observers.push(()=>window.removeEventListener("resize",n))}};var Xr=[.05,.51,.91],ps=[{selector:"#auth-shell, #app-shell",role:"shape",cornerRadius:26,surfaceColor:[1,1,1,.08],blurRadius:8,saturation:1.5},{selector:".app-bar",role:"shape",cornerRadius:26,surfaceColor:[1,1,1,.05],blurRadius:4,saturation:1.4},{selector:".app-nav",role:"shape",cornerRadius:0,surfaceColor:[1,1,1,.04],blurRadius:4,saturation:1.4},{selector:".btn:not(.ghost)",role:"button",cornerRadius:14,surfaceColor:[...Xr,.62],tintColor:[...Xr,.18],blurRadius:2,saturation:1.5}];function qr(){if(document.querySelector("canvas[data-liquid-glass]"))return;let e=document.createElement("canvas");e.setAttribute("data-liquid-glass",""),e.setAttribute("aria-hidden","true"),e.style.cssText="position:fixed;inset:0;z-index:0;pointer-events:none;display:block;width:100%;height:100%";let r=document.getElementById("stage");document.body.insertBefore(e,r);let t;try{t=new Xe(e,{targets:ps})}catch(s){e.remove(),console.warn("[liquid-glass] disabled \u2014",s);return}t.start().catch(s=>{console.warn("[liquid-glass] wallpaper failed, keeping CSS glass \u2014",s),t.dispose()}),window.LiquidGlass={overlay:t}}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",qr,{once:!0}):qr();})();
