// Détecteur-correcteur d'un défaut du compilateur de Next (16.2.x) : un texte JSX qui contient un retour à la ligne ET
// une entité HTML perd son espace de DÉBUT quand il suit un élément ou une expression sur la même ligne.
// Usage : node scripts/espaces-jsx.mjs [--fix]
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join,relative,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const ts=require('typescript');

const ENTITE=/&(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/;

function noeudsPerdants(texte,nom){
  const sf=ts.createSourceFile(nom,texte,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const cas=[];
  const visite=(n)=>{
    if(n.kind===ts.SyntaxKind.JsxText){
      const p=n.parent;
      const freres=p&&p.children;
      if(freres&&freres.indexOf(n)>0){
        const brut=texte.slice(n.pos,n.end);
        const m=/^[ \t]+(?=\S)/.exec(brut);
        if(m&&/[\r\n]/.test(brut)&&ENTITE.test(brut)){
          const lc=sf.getLineAndCharacterOfPosition(n.pos);
          cas.push({position:n.pos,debutBlancs:m[0].length,ligne:lc.line+1,colonne:lc.character+1,extrait:brut.trimStart().slice(0,60)});
        }
      }
    }
    ts.forEachChild(n,visite);
  };
  visite(sf);
  return cas;
}

export function casPerdants(texteSource,nomDeFichier='x.tsx'){
  return noeudsPerdants(texteSource,nomDeFichier).map(({position,ligne,colonne,extrait})=>({position,ligne,colonne,extrait}));
}

export function corriger(texteSource,nomDeFichier='x.tsx'){
  let t=texteSource;
  for(const c of noeudsPerdants(texteSource,nomDeFichier).sort((a,b)=>b.position-a.position)){
    t=t.slice(0,c.position)+'{" "}'+t.slice(c.position+c.debutBlancs);
  }
  return t;
}

export function fichiersTsx(racine){
  const out=[];
  const parcours=(d)=>{
    for(const e of readdirSync(d,{withFileTypes:true})){
      if(e.name.startsWith('.')||e.name==='node_modules')continue;
      const p=join(d,e.name);
      if(e.isDirectory())parcours(p);
      else if(e.isFile()&&e.name.endsWith('.tsx'))out.push(p);
    }
  };
  parcours(racine);
  return out;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const racine=join(dirname(fileURLToPath(import.meta.url)),'..');
  const fix=process.argv.includes('--fix');
  const rel=(f)=>relative(racine,f).replaceAll(sep,'/');
  const scan=()=>{const r=[];for(const f of fichiersTsx(racine)){for(const c of casPerdants(readFileSync(f,'utf8'),f))r.push({f,...c});}return r;};
  let cas=scan();
  for(const c of cas)console.log(`${rel(c.f)}:${c.ligne}:${c.colonne}  ${JSON.stringify(c.extrait)}`);
  console.log(`Total : ${cas.length}`);
  if(fix&&cas.length){
    for(const f of new Set(cas.map((c)=>c.f))){
      const src=readFileSync(f,'utf8');
      writeFileSync(f,corriger(src,f));
    }
    cas=scan();
    console.log(cas.length===0?'Corrigé : zéro cas.':`ERREUR : ${cas.length} cas restants`);
    process.exit(cas.length===0?0:1);
  }
  process.exit(cas.length?1:0);
}
