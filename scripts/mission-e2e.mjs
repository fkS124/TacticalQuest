import { io } from 'socket.io-client';
const URL='http://localhost:3000'; let fail=0;
const ck=(n,c)=>{console.log(`${c?'✓':'✗'} ${n}`); if(!c)fail++;};
const conn=()=>new Promise((res,rej)=>{const s=io(URL,{transports:['websocket']});s.on('connect',()=>res(s));s.on('connect_error',rej);setTimeout(()=>rej(new Error('timeout')),5000);});
const ack=(s,e,p)=>s.timeout(5000).emitWithAck(e,p);
const once=(s,e,ms=5000)=>new Promise((res,rej)=>{s.once(e,res);setTimeout(()=>rej(new Error('to '+e)),ms);});
const chef=await conn();
const c=await ack(chef,'create_room',{callsign:'Chef',sidc:'SFGPUCI----'});
const sub=await conn();
const j=await ack(sub,'join_room',{roomCode:c.roomCode,callsign:'Bravo',sidc:'SFGPUCI----'});
// chef envoie une mission au sub
const onMission=once(sub,'order');
const m={id:'mis-1',authorId:c.memberId,ts:Date.now(),kind:'mission',payload:{kind:'mission',missionType:'seize',lat:45,lng:5,assignee:j.memberId}};
const a=await ack(chef,'send_order',m);
ck('send_order mission accepté',a.ok);
const recv=await onMission;
ck('mission relayée au subordonné',recv.id==='mis-1'&&recv.payload.kind==='mission'&&recv.payload.missionType==='seize');
// sub accuse réception
const onAck=once(chef,'order');
const st={id:'st-1',authorId:j.memberId,ts:Date.now(),kind:'mission_status',payload:{kind:'mission_status',missionId:'mis-1',status:'ack'}};
const a2=await ack(sub,'send_order',st);
ck('mission_status ack accepté',a2.ok);
const recvAck=await onAck;
ck('accusé de réception relayé au chef',recvAck.payload.kind==='mission_status'&&recvAck.payload.status==='ack');
// retardataire reçoit la mission via room_state
const late=await conn();
const lj=await ack(late,'join_room',{roomCode:c.roomCode,callsign:'Charlie',sidc:'SFGPUCI----'});
const hasMission=lj.roomState.recentOrders.some(o=>o.id==='mis-1');
ck('retardataire reçoit la mission (recentOrders)',hasMission);
chef.disconnect();sub.disconnect();late.disconnect();
console.log(fail===0?'\nMissions E2E : OK':`\n${fail} échec(s)`);process.exit(fail?1:0);
