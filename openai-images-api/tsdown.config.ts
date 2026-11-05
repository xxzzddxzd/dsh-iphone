import type { UserConfig } from 'tsdown'
export default [
 {entry:{index:'src/index.ts'},outDir:'lib',format:['esm'],platform:'node',target:'es2024',fixedExtension:false,dts:true,clean:true,deps:{neverBundle:[/^@deepseek-ai\//u]}},
 {entry:{client:'src/client/index.tsx'},outDir:'lib',format:'cjs',platform:'browser',dts:false,clean:false,deps:{neverBundle:['react','react/jsx-runtime','react-dom','react-dom/client','@deepseek-ai/cordis']},define:{'process.env.NODE_ENV':JSON.stringify(process.env.NODE_ENV??'production')},outputOptions:{entryFileNames:'client.js',banner:'window.__ModuleLoader__.load({ id: "dsh-openai-images-api", factory: (require) => {',footer:'return module.exports; } });',intro:'var module = { exports: {} }; var exports = module.exports;'}}
] satisfies UserConfig[]
