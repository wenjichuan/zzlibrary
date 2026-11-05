/** 3D 书架场景（正交双视图版）：

- aisle（默认，Y-Z 平面）：正视一排排书架侧板——二级分类名 + 三级分类层标签
- shelf（X-Z 平面，点击书架进入）：单架时间轴——横轴时间段刻度、纵轴三级分类层
轴系：X=时间、Y(深度)=二级分类、Z(竖直)=三级分类；数量由架上的书直接体现。
质感：木纹贴图 + 柔和阴影 + 书的微随机（高度/微倾/深浅）+ 有厚度的刻度尺与组牌。
*/
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import {
  BASE_H,
  BOARD_T,
  BOOK_D,
  BOOK_H,
  FLOOR_H,
  SIDE_T,
  bookLocalPosition,
  computeLayout,
} from "./layout";
import {
  loadSpineTexture,
  makeGroupSignTexture,
  makeSidePanelTexture,
  makeTimeRulerTexture,
  makeWoodTexture,
  placeholderColor,
} from "./textures";
import type { BookSlot, RackLayout, SceneData, SceneLayout, ViewMode } from "./types";

/** 拖拽状态（区分点击与拖动）。 */
const interaction = { movedPx: 0 };

const PAGE_EDGE = "#efe8d8";

/** 由 id 派生稳定的伪随机（书的自然感）。 */
function prand(id: number, salt: number): number {
  const v = Math.sin(id * 127.1 + salt * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

export interface ShelfSceneProps {
  data: SceneData;
  spineUrl: (packageId: number) => string;
  mode: ViewMode;
  selectedRack: string | null; // rack key（二级分类）
  onRackSelect: (key: string | null) => void;
  onPackageClick: (pkgId: number) => void;
}

export default function ShelfScene(props: ShelfSceneProps) {
  const layout = useMemo(() => computeLayout(props.data), [props.data]);
  return (
    <>
      <color attach="background" args={["#efe9dd"]} />
      <ambientLight intensity={0.75} />
      <directionalLight
        position={[3, 14, 5]}
        intensity={0.85}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-16}
        shadow-camera-right={16}
        shadow-camera-top={16}
        shadow-camera-bottom={-16}
        shadow-bias={-0.0002}
        shadow-normalBias={0.02}
      />
      <directionalLight position={[-5, 6, -4]} intensity={0.3} />
      <directionalLight position={[0, 4, 10]} intensity={0.18} />
      <Floor layout={layout} />
      {layout.racks.map((rack) => (
        <Rack
          key={rack.key}
          rack={rack}
          spineUrl={props.spineUrl}
          selected={props.selectedRack === rack.key}
          dimmed={props.mode === "shelf" && props.selectedRack !== null && props.selectedRack !== rack.key}
          onRackSelect={props.onRackSelect}
          onPackageClick={props.onPackageClick}
        />
      ))}
      <CameraRig layout={layout} mode={props.mode} selectedRack={props.selectedRack} />
    </>
  );
}

function Floor({ layout }: { layout: SceneLayout }) {
  const spanZ = layout.bounds.maxZ - layout.bounds.minZ;
  const spanX = layout.bounds.maxX - layout.bounds.minX;
  const size = Math.max(spanZ * 2.2, spanX * 1.6, 24);
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.02, (layout.bounds.minZ + layout.bounds.maxZ) / 2]}
      receiveShadow
    >
      <planeGeometry args={[size, size]} />
      <meshStandardMaterial color="#ded5c3" roughness={0.95} />
    </mesh>
  );
}

function Rack({
  rack,
  spineUrl,
  selected,
  dimmed,
  onRackSelect,
  onPackageClick,
}: {
  rack: RackLayout;
  spineUrl: (id: number) => string;
  selected: boolean;
  dimmed: boolean;
  onRackSelect: (key: string | null) => void;
  onPackageClick: (pkgId: number) => void;
}) {
  const { width: W, depth: D, height: H, floorCount, segments } = rack;
  const sideTex = useMemo(
    () => makeSidePanelTexture(rack.label, rack.floors, FLOOR_H, H, BASE_H),
    [rack.label, rack.floors, H],
  );
  const rulerTex = useMemo(() => makeTimeRulerTexture(segments), [segments]);
  const signTex = useMemo(() => makeGroupSignTexture(rack.label, rack.total), [rack.label, rack.total]);
  const woodFrame = useMemo(() => makeWoodTexture("frame"), []);
  const woodBoard = useMemo(() => makeWoodTexture("board"), []);

  const frameMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: woodFrame,
        color: "#c9ad8a",
        roughness: 0.82,
      }),
    [woodFrame],
  );
  const boardMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: woodBoard,
        color: "#dcc39e",
        roughness: 0.78,
      }),
    [woodBoard],
  );

  const select = (e: ThreeEvent<MouseEvent>) => {
    if (interaction.movedPx > 5) return;
    if (e.intersections.length > 1) return; // 书优先
    e.stopPropagation();
    onRackSelect(selected ? null : rack.key);
  };

  const innerW = W - 2 * SIDE_T;

  return (
    <group position={[0, 0, rack.z]}>
      {/* 点击热区 */}
      <mesh position={[0, H / 2, 0]} onClick={select}>
        <boxGeometry args={[W + 0.2, H + 0.1, D + 0.2]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* 底座 */}
      <mesh position={[0, BASE_H / 2, 0]} material={frameMat} castShadow receiveShadow>
        <boxGeometry args={[W + 0.12, BASE_H, D + 0.1]} />
      </mesh>
      {/* 左侧板 */}
      <mesh position={[-(W - SIDE_T) / 2, BASE_H + (H - BASE_H) / 2, 0]} material={frameMat} castShadow receiveShadow>
        <boxGeometry args={[SIDE_T, H - BASE_H, D]} />
      </mesh>
      {/* 右侧板（+x 面贴：二级名 + 三级层标签） */}
      <mesh position={[(W - SIDE_T) / 2, BASE_H + (H - BASE_H) / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[SIDE_T, H - BASE_H, D]} />
        <meshStandardMaterial attach="material-0" map={sideTex} roughness={0.85} />
        <meshStandardMaterial attach="material-1" map={woodFrame} color="#c9ad8a" roughness={0.85} />
        <meshStandardMaterial attach="material-2" map={woodFrame} color="#c9ad8a" roughness={0.85} />
        <meshStandardMaterial attach="material-3" map={woodFrame} color="#c9ad8a" roughness={0.85} />
        <meshStandardMaterial attach="material-4" map={woodFrame} color="#a98d6c" roughness={0.85} />
        <meshStandardMaterial attach="material-5" map={woodFrame} color="#a98d6c" roughness={0.85} />
      </mesh>
      {/* 每层隔板 + 顶盖 */}
      {Array.from({ length: floorCount + 1 }).map((_, i) => (
        <mesh key={i} position={[0, BASE_H + i * FLOOR_H + BOARD_T / 2, 0]} material={boardMat} castShadow receiveShadow>
          <boxGeometry args={[innerW, BOARD_T, D - 0.06]} />
        </mesh>
      ))}
      {/* 每层前沿：时间刻度尺（有厚度的木条，正面贴刻度） */}
      {Array.from({ length: floorCount }).map((_, i) => (
        <mesh key={i} position={[0, BASE_H + i * FLOOR_H + BOARD_T + 0.062, D / 2 - 0.03]} castShadow>
          <boxGeometry args={[innerW, 0.125, 0.06]} />
          <meshStandardMaterial attach="material-0" map={woodFrame} color="#8f7354" roughness={0.85} />
          <meshStandardMaterial attach="material-1" map={woodFrame} color="#8f7354" roughness={0.85} />
          <meshStandardMaterial attach="material-2" map={woodFrame} color="#8f7354" roughness={0.85} />
          <meshStandardMaterial attach="material-3" map={woodFrame} color="#8f7354" roughness={0.85} />
          <meshBasicMaterial attach="material-4" map={rulerTex} toneMapped={false} />
          <meshStandardMaterial attach="material-5" map={woodFrame} color="#8f7354" roughness={0.85} />
        </mesh>
      ))}

      {/* 选中描边 */}
      {selected && (
        <mesh position={[0, H / 2, 0]}>
          <boxGeometry args={[W + 0.12, H + 0.08, D + 0.12]} />
          <meshBasicMaterial color="#d9a441" wireframe transparent opacity={0.9} />
        </mesh>
      )}
      {/* 非选中架压暗（时间轴视图下聚焦） */}
      {dimmed && (
        <mesh position={[0, H / 2, 0]}>
          <boxGeometry args={[W + 0.02, H + 0.02, D + 0.02]} />
          <meshBasicMaterial color="#efe9dd" transparent opacity={0.55} depthWrite={false} />
        </mesh>
      )}

      {rack.floors.flatMap((floor, fi) =>
        floor.books.map((slot) => (
          <Book
            key={`${slot.pkg.id}-${fi}`}
            slot={slot}
            rack={rack}
            spineUrl={spineUrl(slot.pkg.id)}
            onClick={onPackageClick}
          />
        )),
      )}

      {/* 组牌：面向 +x，有厚度的木牌 */}
      <mesh position={[W / 2 + 0.34, 1.25, 0]} rotation={[0, Math.PI / 2, 0]} castShadow>
        <boxGeometry args={[0.52, 1.5, 0.05]} />
        <meshStandardMaterial attach="material-0" map={woodFrame} color="#6d543c" roughness={0.9} />
        <meshStandardMaterial attach="material-1" map={woodFrame} color="#6d543c" roughness={0.9} />
        <meshStandardMaterial attach="material-2" map={woodFrame} color="#6d543c" roughness={0.9} />
        <meshStandardMaterial attach="material-3" map={woodFrame} color="#6d543c" roughness={0.9} />
        <meshBasicMaterial attach="material-4" map={signTex} toneMapped={false} />
        <meshStandardMaterial attach="material-5" map={woodFrame} color="#6d543c" roughness={0.9} />
      </mesh>
    </group>
  );
}

function Book({
  slot,
  rack,
  spineUrl,
  onClick,
}: {
  slot: BookSlot;
  rack: RackLayout;
  spineUrl: string;
  onClick: (pkgId: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const tex = useMemo(() => {
    try {
      return loadSpineTexture(spineUrl);
    } catch {
      return null;
    }
  }, [spineUrl]);

  const pos = bookLocalPosition(slot, rack);
  // 自然感微随机：高度 ±5%、微倾 ±1.2°、深浅 ±4%（同 id 稳定）
  const hScale = 0.95 + prand(slot.pkg.id, 1) * 0.1;
  const lean = (prand(slot.pkg.id, 2) - 0.5) * 0.042;
  const zJitter = (prand(slot.pkg.id, 3) - 0.5) * 0.024;
  const targetScale = hovered ? 1.09 : 1;
  const ref = useRef<THREE.Mesh>(null);
  useFrame(() => {
    if (ref.current) {
      const s = THREE.MathUtils.lerp(ref.current.scale.y, targetScale, 0.25);
      ref.current.scale.y = s;
      ref.current.position.y = pos.y + (s - 1) * BOOK_H * hScale * 0.45;
    }
  });

  useEffect(() => {
    document.body.style.cursor = hovered ? "pointer" : "auto";
    return () => {
      document.body.style.cursor = "auto";
    };
  }, [hovered]);

  const t = slot.thickness;
  return (
    <mesh
      ref={ref}
      position={[pos.x, pos.y, pos.z + zJitter]}
      rotation={[0, 0, lean]}
      castShadow
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={() => setHovered(false)}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        if (interaction.movedPx > 5) return;
        e.stopPropagation();
        onClick(slot.pkg.id);
      }}
    >
      <boxGeometry args={[t, BOOK_H * hScale, BOOK_D]} />
      {/* 材质顺序：+x, -x, +y, -y, +z(书脊朝前), -z */}
      <meshStandardMaterial attach="material-0" color={PAGE_EDGE} roughness={1} />
      <meshStandardMaterial attach="material-1" color={PAGE_EDGE} roughness={1} />
      <meshStandardMaterial attach="material-2" color="#f7f1e2" roughness={1} />
      <meshStandardMaterial attach="material-3" color="#e2d9c4" roughness={1} />
      <meshStandardMaterial
        attach="material-4"
        map={tex ?? undefined}
        color={tex ? "#ffffff" : placeholderColor(slot.pkg.id)}
        roughness={0.72}
        emissive={hovered ? "#6b5320" : "#000000"}
        toneMapped={false}
      />
      <meshStandardMaterial attach="material-5" color="#b8ad98" roughness={0.9} />
    </mesh>
  );
}

/** 双视图相机装置（远距透视逼近正交）：
- aisle：相机在 +x 远处沿 -x 看（屏横=z 排向、屏纵=y），拖拽左右平移，滚轮缩放
- shelf：相机在 +z 远处沿 -z 看选中的架（屏横=x 时间轴、屏纵=y 层），拖拽平移，滚轮缩放
缩放用 viewHeight（可见世界高度）表达；D 固定远处，fov 随之变化 → 近似正交观感。
*/
function CameraRig({
  layout,
  mode,
  selectedRack,
}: {
  layout: SceneLayout;
  mode: ViewMode;
  selectedRack: string | null;
}) {
  const { gl, size, camera } = useThree();
  const pan = useRef({ x: 0, y: 0, z: 0 });
  const viewH = useRef(6); // 可见世界高度
  const desired = useRef({ target: new THREE.Vector3(), viewH: 6 });
  const lookTarget = useRef(new THREE.Vector3());
  const drag = useRef<{ x: number; y: number } | null>(null);
  const D = 60; // 相机距离（远处 + 小 fov ≈ 正交）

  const computeDesired = () => {
    const b = layout.bounds;
    if (mode === "aisle") {
      desired.current = {
        target: new THREE.Vector3(0, b.maxHeight * 0.5 + pan.current.y, pan.current.z),
        viewH: viewH.current,
      };
    } else {
      const rack = layout.racks.find((r) => r.key === selectedRack);
      if (rack) {
        desired.current = {
          target: new THREE.Vector3(pan.current.x, rack.height * 0.5 + pan.current.y, rack.z),
          viewH: viewH.current,
        };
      }
    }
  };

  // 模式/选架切换：适配取景并居中
  useEffect(() => {
    const b = layout.bounds;
    if (mode === "aisle") {
      const spanZ = Math.max(b.maxZ - b.minZ, 2) + 2.2;
      const spanY = b.maxHeight + 2.6;
      const pxPerUnit = Math.min(size.width / spanZ, size.height / spanY);
      viewH.current = size.height / Math.max(pxPerUnit, 0.001);
      pan.current = { x: 0, y: 0, z: (b.minZ + b.maxZ) / 2 };
    } else {
      const rack = layout.racks.find((r) => r.key === selectedRack);
      if (rack) {
        const pxPerUnit = Math.min(size.width / (rack.width + 1.4), size.height / (rack.height + 1.6));
        viewH.current = size.height / Math.max(pxPerUnit, 0.001);
        pan.current = { x: 0, y: 0, z: 0 };
      }
    }
    computeDesired();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selectedRack, size.width, size.height]);

  useEffect(() => {
    const el = gl.domElement;
    const onDown = (e: PointerEvent) => {
      drag.current = { x: e.clientX, y: e.clientY };
      interaction.movedPx = 0;
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag.current) return;
      const dx = e.clientX - drag.current.x;
      const dy = e.clientY - drag.current.y;
      drag.current = { x: e.clientX, y: e.clientY };
      interaction.movedPx += Math.abs(dx) + Math.abs(dy);
      const k = viewH.current / Math.max(size.height, 1); // 屏幕像素 → 世界单位
      if (mode === "aisle") {
        pan.current.z += dx * k;
        pan.current.y = THREE.MathUtils.clamp(pan.current.y + dy * k, -3, 8);
      } else {
        pan.current.x -= dx * k;
        pan.current.y = THREE.MathUtils.clamp(pan.current.y + dy * k, -3, 10);
      }
      computeDesired();
    };
    const onUp = (e: PointerEvent) => {
      drag.current = null;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      viewH.current = THREE.MathUtils.clamp(viewH.current * (1 + e.deltaY * 0.0012), 1.2, 40);
      computeDesired();
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("wheel", onWheel);
    };
  }, [gl, mode, layout, size.height]);

  useFrame(() => {
    const cam = camera as THREE.PerspectiveCamera;
    computeDesired();
    const desiredPos =
      mode === "aisle"
        ? new THREE.Vector3(desired.current.target.x + D, desired.current.target.y, desired.current.target.z)
        : new THREE.Vector3(desired.current.target.x, desired.current.target.y, desired.current.target.z + D);
    cam.position.lerp(desiredPos, 0.14);
    lookTarget.current.lerp(desired.current.target, 0.16);
    const vh = THREE.MathUtils.lerp(
      (cam.fov / 360) * Math.PI * 2 * D,
      desired.current.viewH,
      0.18,
    );
    cam.fov = (2 * Math.atan(vh / (2 * D)) * 180) / Math.PI;
    cam.updateProjectionMatrix();
    cam.lookAt(lookTarget.current);
    cam.updateMatrixWorld();
  });

  return null;
}
