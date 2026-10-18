import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

function dispose(group) {
  for (const child of [...group.children]) {
    child.traverse(o => {
      if (o.geometry) o.geometry.dispose()
      const m = o.material
      if (m) (Array.isArray(m) ? m : [m]).forEach(v => v.dispose())
    })
    group.remove(child)
  }
}
function sphere(radius, color) {
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 10), new THREE.MeshBasicMaterial({ color }))
}

export default function Scene({ terrain, result, frame, vex, showSurface, showBounds, showTerrain, currentArrow }) {
  const host = useRef(null)
  const objects = useRef(null)
  useEffect(() => {
    const el = host.current
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#071420')
    scene.fog = new THREE.Fog('#071420', 35, 75)
    const camera = new THREE.PerspectiveCamera(50, 1, .02, 150)
    camera.up.set(0,0,1)
    camera.position.set(12,-17,11)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.target.set(0,0,-1.5)
    controls.maxDistance=65
    controls.minDistance=.7
    scene.add(new THREE.AmbientLight(0xffffff,.76))
    const sun = new THREE.DirectionalLight(0xd0e5ff,1.3);sun.position.set(-7,-7,12);scene.add(sun)
    const base = new THREE.Group(), plume = new THREE.Group(), extras = new THREE.Group()
    scene.add(base,plume,extras)
    const resize = () => {
      const w = Math.max(1,el.clientWidth), h = Math.max(1,el.clientHeight)
      renderer.setSize(w,h,false)
      camera.aspect=w/h
      camera.updateProjectionMatrix()
    }
    const observer=new ResizeObserver(resize);observer.observe(el);resize()
    objects.current={camera, controls, scene, renderer, base, plume, extras}
    let anim
    const loop=()=>{anim=requestAnimationFrame(loop);controls.update();renderer.render(scene,camera)}
    loop()
    return ()=>{
      cancelAnimationFrame(anim);observer.disconnect();controls.dispose()
      dispose(base);dispose(plume);dispose(extras)
      renderer.dispose();renderer.forceContextLoss()
      if(renderer.domElement.parentNode===el)el.removeChild(renderer.domElement)
      objects.current=null
    }
  },[])
  useEffect(()=>{
    const obj=objects.current
    if(!obj || !terrain)return
    const {base}=obj
    dispose(base)
    const {n,L,h,max_depth:depth}=terrain
    const mesh=new THREE.PlaneGeometry(L,L,n-1,n-1)
    const p=mesh.getAttribute('position'), colors=new Float32Array(p.count*3)
    for(let i=0;i<p.count;i++){
      const ix=Math.max(0,Math.min(n-1,Math.round((p.getX(i)/L+.5)*(n-1))))
      const iy=Math.max(0,Math.min(n-1,Math.round((p.getY(i)/L+.5)*(n-1))))
      const elev=h[iy*n+ix]
      p.setZ(i,elev/1000*vex)
      const color=new THREE.Color()
      if(elev>0)color.setHSL(.27,.29,.20+Math.min(.22,elev/700))
      else color.setHSL(.56,.6,.25+Math.min(.28,Math.abs(elev)/Math.max(100,depth)*.18))
      colors[i*3]=color.r;colors[i*3+1]=color.g;colors[i*3+2]=color.b
    }
    mesh.setAttribute('color',new THREE.BufferAttribute(colors,3));mesh.computeVertexNormals()
    const land=new THREE.Mesh(mesh,new THREE.MeshLambertMaterial({vertexColors:true,side:THREE.DoubleSide,flatShading:false,transparent:true,opacity:showTerrain?1:0,depthWrite:showTerrain}))
    land.visible=showTerrain
    base.add(land)
    if(showSurface){
      const w=new THREE.Mesh(new THREE.PlaneGeometry(L,L),new THREE.MeshPhongMaterial({color:0x2489c4,transparent:true,opacity:.13,depthWrite:false,side:THREE.DoubleSide,shininess:75}))
      w.position.z=.001;base.add(w)
    }
    if(showBounds){
      const bottom=-Math.min(2500,Math.max(100,depth))*vex/1000
      const edges=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(L,L,Math.abs(bottom))),new THREE.LineBasicMaterial({color:0x31729b,transparent:true,opacity:.7}))
      edges.position.z=bottom/2;base.add(edges)
    }
    // Reference origin + graticule within the local coordinate system (km).
    const guideMat = new THREE.LineBasicMaterial({color:0x17415c,transparent:true,opacity:.48})
    const verts=[]
    for(let x=-6;x<=6;x+=2){verts.push(x,-L/2,0,x,L/2,0)}
    for(let y=-6;y<=6;y+=2){verts.push(-L/2,y,0,L/2,y,0)}
    const grid=new THREE.BufferGeometry();grid.setAttribute('position',new THREE.Float32BufferAttribute(verts,3))
    const helper=new THREE.LineSegments(grid,guideMat);helper.position.z=.02;base.add(helper)
  },[terrain,vex,showSurface,showBounds,showTerrain])
  useEffect(()=>{
    const obj=objects.current
    if(!obj)return
    const {plume,extras}=obj
    dispose(plume);dispose(extras)
    if(currentArrow){
      const [u,v]=currentArrow
      if(Number.isFinite(u)&&Number.isFinite(v)&&Math.hypot(u,v)>1e-4){
        const dir=new THREE.Vector3(u,v,0).normalize()
        const arrow=new THREE.ArrowHelper(dir,new THREE.Vector3(-6.6,5.7,.28),2.1,0x49d4e0,.5,.26)
        extras.add(arrow)
      }
    }
    if(!result)return
    const [rx,ry]=result.inputs.release_km
    const release=sphere(.135,0xffd76a)
    release.position.set(rx,ry,-result.inputs.depth_m*vex/1000)
    plume.add(release)
    const otherReleases = result.inputs.additional_release_km || []
    const otherDepths = result.inputs.additional_release_depth_m || []
    for(let i=0;i<otherReleases.length;i++){
      const [sx,sy] = otherReleases[i]
      const dot=sphere(.115,0xffd76a)
      dot.position.set(sx,sy,-(otherDepths[i] || 0)*vex/1000)
      plume.add(dot)
    }
    if(!frame)return
    const pos=[],col=[]
    for(const [x,y,z,intensity] of frame.points){
      pos.push(x,y,z/1000*vex)
      const c=new THREE.Color().setHSL(.52-.52*Math.pow(intensity,.65),.98,.58)
      col.push(c.r,c.g,c.b)
    }
    for(const [x,y,z] of frame.beached){
      pos.push(x,y,z/1000*vex)
      col.push(.93,.94,.96)
    }
    if(pos.length){
      const geom=new THREE.BufferGeometry()
      geom.setAttribute('position',new THREE.Float32BufferAttribute(pos,3))
      geom.setAttribute('color',new THREE.Float32BufferAttribute(col,3))
      const particles=new THREE.Points(geom,new THREE.PointsMaterial({size:4,vertexColors:true,sizeAttenuation:false,depthWrite:false,transparent:true,opacity:.93}))
      particles.frustumCulled=false
      plume.add(particles)
    }
  },[result,frame,vex,currentArrow?.[0],currentArrow?.[1]])
  return <div ref={host} className="threeHost" />
}
