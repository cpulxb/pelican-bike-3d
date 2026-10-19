"""
process.py —— 把 gen.py 生成的原图（raw/*.png）做成游戏用贴图（assets/textures/*.webp）

  · seamless()：半周期错位 + 带噪声边界的羽化混合，修掉平铺接缝
  · 细节色：线性空间里除以平均色（归一化），再缩放到 [0,1] 存成 sRGB webp；
    缩放倍数（gain）写进 manifest.json，需要同步到 js/gfx/textures.js 的 ART_GAIN
  · 法线：亮度 → 高斯模糊 → 环绕差分（保证法线也无缝），RG = 法线 xy，B = 高度
  · 海面：细浪高度图 → 法线（RG）+ 白沫亮度（B）合成一张
依赖：numpy pillow scipy
"""
import numpy as np, json, os
from PIL import Image, ImageFilter
from scipy.ndimage import gaussian_filter
OUT=os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","..","assets","textures"); os.makedirs(OUT,exist_ok=True)
def s2l(x): return np.where(x<=0.04045,x/12.92,((x+0.055)/1.055)**2.4)
def l2s(x): x=np.clip(x,0,1); return np.where(x<=0.0031308,x*12.92,1.055*x**(1/2.4)-0.055)
def load(n): return np.asarray(Image.open(f"raw/{n}.png").convert("RGB")).astype(np.float64)/255
def seamless(a, band=0.14, seed=1):
    H,W=a.shape[:2]
    off=np.roll(np.roll(a,H//2,0),W//2,1)
    yy=np.minimum(np.arange(H),H-1-np.arange(H))/H; xx=np.minimum(np.arange(W),W-1-np.arange(W))/W
    d=np.minimum(yy[:,None],xx[None,:])  # distance to nearest edge (0..0.5)
    rng=np.random.default_rng(seed); nz=gaussian_filter(rng.random((H,W)),12,mode='wrap'); nz=(nz-nz.mean())/nz.std()*0.025
    t=np.clip((d+nz)/band,0,1); w=t*t*(3-2*t)
    if a.ndim==3: w=w[...,None]
    return a*w+off*(1-w)
def save(arr,name,q=82,mode="RGB"):
    im=Image.fromarray((np.clip(arr,0,1)*255+0.5).astype(np.uint8),mode)
    im.save(f"{OUT}/{name}.webp","WEBP",quality=q,method=6)
    return os.path.getsize(f"{OUT}/{name}.webp")
def normal_from_height(h, strength):
    gx=(np.roll(h,-1,1)-np.roll(h,1,1))*0.5; gy=(np.roll(h,-1,0)-np.roll(h,1,0))*0.5
    nx=-gx*strength; ny=-gy*strength; nz=np.ones_like(h)
    l=np.sqrt(nx*nx+ny*ny+nz*nz); return nx/l, ny/l, nz/l
manifest={}
def lum(a): return a[...,0]*0.2126+a[...,1]*0.7152+a[...,2]*0.0722
# --- terrain layers: albedo (normalized detail, sRGB) + normal(RG)+height(B) linear
for n,strength,blur in [("sand",9,1.0),("wetsand",7,1.0),("grass",6,0.8),("rock",10,1.2)]:
    a=seamless(load(n))
    lin=s2l(a); mean=lin.reshape(-1,3).mean(0)
    ratio=lin/mean; p=np.percentile(ratio,99.7); s=1/p
    sz=save(l2s(ratio*s),f"{n}_albedo",82)
    h=gaussian_filter(lum(a),blur,mode='wrap'); h=(h-h.min())/(h.max()-h.min())
    nx,ny,nz=normal_from_height(h,strength*4)
    nm=np.stack([nx*0.5+0.5,ny*0.5+0.5,h],-1)
    sz2=save(nm,f"{n}_normal",88)
    manifest[n]={"gain":round(float(1/s),4),"meanLinear":[round(float(x),4) for x in mean],"kb":[sz//1024,sz2//1024]}
# --- sea: ripple normal (RG) + foam (B)
r=seamless(load("ripple_h")); h=gaussian_filter(lum(r),1.2,mode='wrap'); h=(h-h.min())/(h.max()-h.min())
nx,ny,nz=normal_from_height(h,10)
f=seamless(load("foam")); fo=lum(f); fo=(fo-np.percentile(fo,2))/(np.percentile(fo,99.5)-np.percentile(fo,2))
sz=save(np.stack([nx*0.5+0.5,ny*0.5+0.5,np.clip(fo,0,1)],-1),"sea_normal_foam",88)
manifest["sea"]={"kb":sz//1024}
# --- prop detail: wood & plaster normalized around 0.5 (sRGB stored but used as linear ratio*2)
for n in ["wood","plaster"]:
    a=load(n) if n=="wood" else seamless(load(n))
    if n=="wood": a=seamless(a,band=0.06)
    lin=s2l(a); mean=lin.reshape(-1,3).mean(0); ratio=lin/mean
    p=np.percentile(ratio,99.7); s=1/p
    img=Image.fromarray((np.clip(l2s(ratio*s),0,1)*255+.5).astype(np.uint8)).resize((512,512),Image.LANCZOS)
    img.save(f"{OUT}/{n}_detail.webp","WEBP",quality=82,method=6)
    manifest[n]={"gain":round(float(1/s),4),"meanLinear":[round(float(x),4) for x in mean],"kb":os.path.getsize(f"{OUT}/{n}_detail.webp")//1024}
json.dump(manifest,open("manifest.json","w"),indent=1); print(json.dumps(manifest))
