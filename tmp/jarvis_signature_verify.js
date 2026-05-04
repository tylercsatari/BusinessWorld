const data=require('../buildings/jarvis/viral-ideas.json');
const st=data.ideas[0].synthesis_trace;
console.log(JSON.stringify({
  proof_surface: st.proof_surface,
  validated_premise_signature: st.validated_premise_signature,
  remaining_static_inputs: st.remaining_static_inputs,
}, null, 2));
