const data=require('../buildings/jarvis/viral-ideas.json');
const st=data.ideas[0].synthesis_trace;
console.log(JSON.stringify({
  title_premise_line: st.validated_premise_signature && st.validated_premise_signature.title_premise_line,
  proof_surface: st.proof_surface,
  top_title: data.ideas[0].title
}, null, 2));
