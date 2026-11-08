const memberService = require("./memberService");
const therapistRepository = require("../repositories/therapistRepository");

async function enrichUser(user, client) {
  if (!user) return null;
  const [effectiveRole, therapist] = await Promise.all([
    memberService.getEffectiveRole(user, client),
    therapistRepository.findActiveByUserId(user.id, client)
  ]);
  const admin = user.role === "admin";
  const isTherapist = !!therapist;
  return {
    ...user,
    effectiveRole,
    therapistId: therapist ? therapist.id : null,
    therapistName: therapist ? therapist.name : null,
    capabilities: {
      admin,
      therapist: isTherapist,
      bookAppointment: !admin && !isTherapist && effectiveRole === "member",
      viewAssignedAppointments: isTherapist,
      checkInAssignedAppointment: isTherapist
    }
  };
}

module.exports = { enrichUser };
