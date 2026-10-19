"use client";

import { useEffect, useRef, useState } from "react";

function canRunHeroWebGL(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if (window.matchMedia("(pointer: coarse)").matches) return false;
  const nav = navigator as Navigator & {
    connection?: { saveData?: boolean };
    deviceMemory?: number;
  };
  if (nav.connection?.saveData) return false;
  if (typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency < 4) return false;
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory < 4) return false;
  return true;
}

export default function HeroWebGLCanvas({ imageSrc }: { imageSrc: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !canRunHeroWebGL()) return;

    let disposed = false;
    let rafId = 0;
    let isVisible = true;
    let cleanupFn: (() => void) | null = null;

    void (async () => {
      try {
        const THREE = await import("three");
        if (disposed || !containerRef.current) return;

        const renderer = new THREE.WebGLRenderer({
          alpha: false,
          antialias: false,
          powerPreference: "low-power",
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

        const canvas = renderer.domElement;
        canvas.className = "w-full h-full object-cover pointer-events-none";
        canvas.setAttribute("aria-hidden", "true");
        container.innerHTML = "";
        container.appendChild(canvas);

        const scene = new THREE.Scene();
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

        const uniforms = {
          uTexture: { value: null as unknown },
          uTime: { value: 0 },
          uPointer: { value: new THREE.Vector2(0.5, 0.5) },
          uScroll: { value: 0 },
          uResolution: { value: new THREE.Vector2(1, 1) },
          uImageAspect: { value: 1.6 },
        };

        const material = new THREE.ShaderMaterial({
          uniforms,
          vertexShader: `
            varying vec2 vUv;
            void main() {
              vUv = uv;
              gl_Position = vec4(position, 1.0);
            }
          `,
          fragmentShader: `
            precision mediump float;
            uniform sampler2D uTexture;
            uniform float uTime;
            uniform vec2 uPointer;
            uniform float uScroll;
            uniform vec2 uResolution;
            uniform float uImageAspect;
            varying vec2 vUv;

            float hash(vec2 p) {
              return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
            }

            void main() {
              float viewAspect = uResolution.x / max(uResolution.y, 1.0);
              vec2 ratio = vec2(
                min(viewAspect / uImageAspect, 1.0),
                min(uImageAspect / viewAspect, 1.0)
              );
              vec2 uv = vec2(
                vUv.x * ratio.x + (1.0 - ratio.x) * 0.5,
                vUv.y * ratio.y + (1.0 - ratio.y) * 0.5
              );

              vec2 centered = vUv - 0.5;
              float dist = length(centered);
              vec2 pointerDelta = (uPointer - 0.5) * 0.016 * (1.0 - smoothstep(0.0, 0.78, dist));
              vec2 wave = vec2(
                sin(uTime * 0.35 + uv.y * 5.2),
                cos(uTime * 0.28 + uv.x * 4.4)
              ) * 0.0018;

              float scrollMask = clamp(uScroll * 0.14, 0.0, 0.12);
              vec2 sampleUv = clamp(uv + pointerDelta + wave + vec2(0.0, scrollMask * 0.2), 0.004, 0.996);
              vec4 tex = texture2D(uTexture, sampleUv);

              float light = 0.86 + 0.22 * (1.0 - smoothstep(0.05, 0.85, length(vUv - uPointer)));
              float vignette = smoothstep(1.05, 0.2, dist);
              float grain = (hash(gl_FragCoord.xy + floor(uTime * 14.0)) - 0.5) * 0.032;

              vec3 color = tex.rgb * light * (0.72 + 0.28 * vignette) + grain;
              color = mix(color, vec3(0.05, 0.07, 0.06), clamp(uScroll * 0.45, 0.0, 0.45));
              gl_FragColor = vec4(color, 1.0);
            }
          `,
        });

        const geometry = new THREE.PlaneGeometry(2, 2);
        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);

        const resize = () => {
          if (!containerRef.current) return;
          const rect = containerRef.current.getBoundingClientRect();
          const w = Math.max(1, Math.round(rect.width));
          const h = Math.max(1, Math.round(rect.height));
          renderer.setSize(w, h, false);
          uniforms.uResolution.value.set(w, h);
        };
        resize();

        const loader = new THREE.TextureLoader();
        loader.load(
          imageSrc,
          (tex) => {
            if (disposed) {
              tex.dispose();
              return;
            }
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            const img = tex.image as { width?: number; height?: number } | undefined;
            if (img?.width && img?.height) {
              uniforms.uImageAspect.value = img.width / img.height;
            }
            uniforms.uTexture.value = tex;
            setReady(true);
          },
          undefined,
          () => {
            setReady(false);
          },
        );

        const targetPointer = { x: 0.5, y: 0.5 };
        const onPointerMove = (e: PointerEvent) => {
          const rect = container.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          targetPointer.x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
          targetPointer.y = Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height));
        };

        const onScroll = () => {
          const vh = Math.max(window.innerHeight, 1);
          uniforms.uScroll.value = Math.min(1, Math.max(0, window.scrollY / vh));
        };

        const observer = new IntersectionObserver(
          (entries) => {
            isVisible = Boolean(entries[0]?.isIntersecting);
          },
          { threshold: 0.02 },
        );
        observer.observe(container);

        const onContextLost = (e: Event) => {
          e.preventDefault();
          isVisible = false;
          setReady(false);
        };
        const onContextRestored = () => {
          resize();
          isVisible = true;
          setReady(true);
        };

        canvas.addEventListener("webglcontextlost", onContextLost);
        canvas.addEventListener("webglcontextrestored", onContextRestored);
        window.addEventListener("pointermove", onPointerMove, { passive: true });
        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", resize);

        const start = performance.now();
        const renderLoop = (now: number) => {
          if (disposed) return;
          if (isVisible && uniforms.uTexture.value) {
            uniforms.uTime.value = (now - start) * 0.001;
            const p = uniforms.uPointer.value;
            p.x += (targetPointer.x - p.x) * 0.06;
            p.y += (targetPointer.y - p.y) * 0.06;
            renderer.render(scene, camera);
          }
          rafId = window.requestAnimationFrame(renderLoop);
        };
        rafId = window.requestAnimationFrame(renderLoop);

        cleanupFn = () => {
          observer.disconnect();
          canvas.removeEventListener("webglcontextlost", onContextLost);
          canvas.removeEventListener("webglcontextrestored", onContextRestored);
          window.removeEventListener("pointermove", onPointerMove);
          window.removeEventListener("scroll", onScroll);
          window.removeEventListener("resize", resize);
          geometry.dispose();
          material.dispose();
          const tex = uniforms.uTexture.value as { dispose?: () => void } | null;
          tex?.dispose?.();
          renderer.dispose();
        };
      } catch {
        setReady(false);
      }
    })();

    return () => {
      disposed = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      cleanupFn?.();
    };
  }, [imageSrc]);

  return (
    <div
      ref={containerRef}
      data-webgl-hero={ready ? "active" : "fallback"}
      aria-hidden="true"
      className={`absolute inset-0 transition-opacity duration-500 ${ready ? "opacity-100" : "opacity-0"}`}
    />
  );
}
