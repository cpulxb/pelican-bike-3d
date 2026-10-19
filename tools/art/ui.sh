#!/bin/sh
# 界面插画 / 羽毛 / 粒子图集的后处理（ImageMagick 7）。在 tools/art 下运行，原图在 raw/。
set -e
U=../../assets/ui; T=../../assets/textures; mkdir -p $U
for m in fish race stunt free; do magick raw/mode_$m.png -resize 768x512 -quality 80 -define webp:method=6 $U/mode-$m.webp; done
for b in raw/badge_*.png; do id=$(basename $b .png); id=${id#badge_}
  magick $b -trim +repage -resize 192x192 -gravity center -background none -extent 192x192 -quality 85 -define webp:method=6 $U/badge-$id.webp; done
magick raw/icon_fish.png -trim +repage -resize 160x160 -gravity center -background none -extent 160x160 -quality 85 $U/fish.webp
magick ../../promo/key-art-1920x1088.jpg -resize 1600x -quality 76 -define webp:method=6 $U/key-art.webp
# 羽毛：按 alpha 裁到外接框，拉成 128×512（与羽片几何 1:3.75 的长宽比接近）
magick raw/feather.png -trim +repage -resize 128x512! -quality 90 -define webp:method=6 -define webp:alpha-quality=100 $T/feather.webp
# 粒子图集 2×2（灰度 = 不透明度）：光球 / 星芒 / 水花 / 绒羽
for s in orb sparkle splash feather; do magick raw/spr_$s.png -colorspace Gray -gravity center -crop 860x860+0+0 +repage -resize 128x128 -level 2%,100% /tmp/p_$s.png; done
magick \( /tmp/p_orb.png /tmp/p_sparkle.png +append \) \( /tmp/p_splash.png /tmp/p_feather.png +append \) -append -colorspace Gray -quality 88 $T/particles.webp
