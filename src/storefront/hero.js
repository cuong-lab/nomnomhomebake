// ── Hero: ảnh nền full-bleed (crossfade ~20s) + quản lý ảnh cho admin ──
// Export:
//   - initHero():      gắn sự kiện quản lý ảnh rồi tải lần đầu.
//   - loadHeroSlides(): tải lại ảnh nền (auth handler gọi khi đổi trạng thái admin).
// Ảnh lấy từ bảng `hero_slides` — cô chủ vẫn thêm/xoá ảnh qua nút "Quản lý ảnh".

import { supabase } from "../supabase.js";
import { compressImage } from "../shared/imageUtils.js";
import { state } from "../store.js";

const heroSlides = document.getElementById("hero-slides");
const heroEditBtn = document.getElementById("hero-edit-btn");
const heroDots = document.getElementById("hero-dots");

let heroLayers = [];
let heroIndex = 0;
let heroTimer = null;

function updateHeroDots() {
  if (!heroDots) return;
  heroDots.querySelectorAll("[data-hero-dot]").forEach((b, idx) =>
    b.classList.toggle("is-active", idx === heroIndex)
  );
}

function goToHeroSlide(i) {
  if (heroLayers.length < 2) return;
  heroLayers[heroIndex].style.opacity = "0";
  heroIndex = ((i % heroLayers.length) + heroLayers.length) % heroLayers.length;
  heroLayers[heroIndex].style.opacity = "1";
  updateHeroDots();
}

function startHeroAutoplay() {
  if (heroTimer) clearInterval(heroTimer);
  if (heroLayers.length > 1) {
    heroTimer = setInterval(() => goToHeroSlide(heroIndex + 1), 20000);
  }
}

export async function loadHeroSlides() {
  const { data } = await supabase
    .from("hero_slides")
    .select("*")
    .order("sort_order", { ascending: true });

  const slides = data || [];
  heroEditBtn.classList.toggle("hidden", !state.isAdmin);

  if (heroTimer) { clearInterval(heroTimer); heroTimer = null; }
  if (heroDots) heroDots.innerHTML = "";

  if (!slides.length) {
    heroSlides.innerHTML = `<div class="flex h-full w-full items-center justify-center bg-earth/40"><span class="font-serif text-xl italic text-cream/70">Ảnh bìa</span></div>`;
    return;
  }

  // Mỗi ảnh là 1 lớp phủ kín, chồng lên nhau; đổi ảnh bằng cách fade opacity.
  heroSlides.innerHTML = slides
    .map(
      (s, i) =>
        `<img src="${s.image_url}" alt="" class="absolute inset-0 h-full w-full object-cover transition-opacity duration-1000 ease-in-out" style="opacity:${i === 0 ? 1 : 0}" />`
    )
    .join("");

  heroLayers = Array.from(heroSlides.querySelectorAll("img"));
  heroIndex = 0;

  // Nhiều ảnh → chấm chọn ảnh + crossfade tự đổi mỗi 20 giây. 1 ảnh → tĩnh, không có chấm.
  if (heroDots && heroLayers.length > 1) {
    heroDots.innerHTML = heroLayers
      .map((_, i) => `<button type="button" data-hero-dot="${i}" class="nn-hero-dot${i === 0 ? " is-active" : ""}" aria-label="Ảnh ${i + 1}"></button>`)
      .join("");
    heroDots.querySelectorAll("[data-hero-dot]").forEach((btn) =>
      btn.addEventListener("click", () => { goToHeroSlide(parseInt(btn.dataset.heroDot)); startHeroAutoplay(); })
    );
  }

  startHeroAutoplay();
}

// ── Quản lý ảnh hero (admin) ──

const slidesModal = document.getElementById("slides-modal");
const slidesList = document.getElementById("slides-list");
const slideUpload = document.getElementById("slide-upload");

async function openSlidesModal() {
  slidesModal.classList.remove("hidden");
  slidesModal.classList.add("flex");
  await renderSlidesList();
}

function closeSlidesModal() {
  slidesModal.classList.add("hidden");
  slidesModal.classList.remove("flex");
}

async function renderSlidesList() {
  const { data } = await supabase.from("hero_slides").select("*").order("sort_order");
  const slides = data || [];

  if (!slides.length) {
    slidesList.innerHTML = `<p class="text-sm text-ash">Chưa có ảnh nào.</p>`;
    return;
  }

  slidesList.innerHTML = slides
    .map(
      (s) => `
    <div class="flex items-center gap-3 border border-earth/40 p-2">
      <img src="${s.image_url}" alt="" class="h-16 w-16 object-cover shrink-0" />
      <span class="text-sm text-ash flex-1 truncate">${s.image_url.split("/").pop()}</span>
      <button data-delete-slide="${s.id}" class="text-xs text-red-500 hover:text-red-700 shrink-0">Xóa</button>
    </div>
  `
    )
    .join("");

  slidesList.querySelectorAll("[data-delete-slide]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await supabase.from("hero_slides").delete().eq("id", btn.dataset.deleteSlide);
      await renderSlidesList();
      loadHeroSlides();
    })
  );
}

export function initHero() {
  heroEditBtn.addEventListener("click", openSlidesModal);
  document.getElementById("slides-close").addEventListener("click", closeSlidesModal);
  slidesModal.addEventListener("click", (e) => { if (e.target === slidesModal) closeSlidesModal(); });

  slideUpload.addEventListener("change", async () => {
    let file = slideUpload.files[0];
    if (!file) return;
    file = await compressImage(file);

    const ext = file.name.split(".").pop();
    const fileName = `hero-${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("product-images")
      .upload(fileName, file, { cacheControl: "31536000" });

    if (uploadError) {
      alert("Lỗi upload: " + uploadError.message);
      return;
    }

    const { data: urlData } = supabase.storage.from("product-images").getPublicUrl(fileName);

    const { data: existing } = await supabase.from("hero_slides").select("sort_order").order("sort_order", { ascending: false }).limit(1);
    const nextOrder = existing?.length ? existing[0].sort_order + 1 : 0;

    await supabase.from("hero_slides").insert({ image_url: urlData.publicUrl, sort_order: nextOrder });

    slideUpload.value = "";
    await renderSlidesList();
    loadHeroSlides();
  });
  // Tải ảnh hero do handler auth gọi loadHeroSlides() (tránh tải 2 lần + chớp).
}
